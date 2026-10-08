// Everything this site knows about Clerk (https://clerk.com): loading the
// SDK, showing the sign-in widget, selecting the organization and deciding
// whether a session is allowed through.
//
// Pages do not talk to window.Clerk themselves. They call start() with a
// node to mount the sign-in widget into and a few callbacks, and get told
// which of four states they are in - signed out, activating, allowed,
// refused. js/admin.js is the only caller today.
//
// This is a client-side gate: it decides what a page renders, not what an
// API will answer. See the note on admin/index.html for why that is an
// honest description of what it protects.
(function () {
  // Custom permission set up in Clerk (Configure > Features). Clerk scopes
  // custom permissions to an organization and checks them against
  // whichever one is active on the session, so an account with no active
  // organization has no permissions at all. If this key does not match
  // Clerk's exactly, the refusal message lists the keys the account does
  // hold, which shows what to put here.
  var REQUIRED_PERMISSION = 'org:log_access:log_enabled';

  // The organization that carries it. A fresh sign-in leaves the active
  // organization null, which is why start() selects this one before
  // judging the permission - without that step a correctly configured
  // account is still refused.
  var ORGANIZATION_ID = 'org_3KIeZpy6RgDWrr3YABEkWduvLz7';

  // Clerk.addListener fires on every client/session resource change - it
  // fires even while the page sits idle - so nothing below may assume it
  // runs once. These latches keep the listener from redoing work.
  var signInMounted = false;
  var orgActivationTried = false;

  var mountTo = null;
  var handlers = {};

  function emit(name, a, b) {
    var fn = handlers[name];
    if (typeof fn === 'function') { fn(a, b); }
  }

  function describe(user) {
    var email = user.primaryEmailAddress && user.primaryEmailAddress.emailAddress;
    return email || user.id;
  }

  // Clerk answers this locally from the session token's claims, so it is
  // synchronous and costs no network call.
  function hasPermission() {
    var session = window.Clerk && window.Clerk.session;
    if (!session || typeof session.checkAuthorization !== 'function') return false;
    return session.checkAuthorization({ permission: REQUIRED_PERMISSION }) === true;
  }

  // Says which permissions the account does hold in the organization, so a
  // refusal caused by a mistyped key is obvious from the page itself. Null
  // (the page's generic wording) when the membership list isn't available.
  function deniedMessage(user) {
    var memberships = (user && user.organizationMemberships) || [];
    for (var i = 0; i < memberships.length; i++) {
      var m = memberships[i];
      if (m && m.organization && m.organization.id === ORGANIZATION_ID) {
        var held = (m.permissions || []).join(', ') || 'none';
        return 'This account does not have the ' + REQUIRED_PERMISSION + ' permission, ' +
          'so the dashboard is hidden. Its permissions in that organization are: ' + held + '.';
      }
    }
    return null;
  }

  function mountSignIn() {
    if (!mountTo) return;
    mountTo.hidden = false;

    // Mount once and leave it alone. Every step of the sign-in flow -
    // creating the attempt, sending the email code, verifying it - changes
    // a Clerk resource and so re-fires the listener. Remounting on those
    // events tears the widget down mid-flow and it asks for a fresh code
    // on the way back up, which is what trips Clerk's rate limit with
    // "Too many requests. Please try again in a bit."
    if (!signInMounted && window.Clerk) {
      window.Clerk.mountSignIn(mountTo);
      signInMounted = true;
    }
  }

  function unmountSignIn() {
    // Let Clerk tear its own widget down. Clearing innerHTML instead would
    // strip the DOM out from under a component that still thinks it is
    // mounted.
    if (signInMounted && window.Clerk) {
      window.Clerk.unmountSignIn(mountTo);
      signInMounted = false;
    }
    if (mountTo) { mountTo.hidden = true; }
  }

  function handleSignedIn(user) {
    unmountSignIn();

    // Select the organization before judging the permission, once.
    // setActive changes a resource and so re-fires the listener, landing
    // back here - the latch is what stops that becoming a loop, and it
    // also means a real failure (not a member, organization deleted) is
    // reported rather than retried forever.
    var active = window.Clerk.organization && window.Clerk.organization.id;
    if (active !== ORGANIZATION_ID && !orgActivationTried) {
      orgActivationTried = true;
      emit('onActivating', user);
      window.Clerk.setActive({ organization: ORGANIZATION_ID })
        .then(function () { handleSignedIn(user); })
        .catch(function (err) {
          emit('onDenied', user, 'Could not select the organization that grants ' +
            REQUIRED_PERMISSION + ' (' + err.message + '). Check that this ' +
            'account is a member of it.');
        });
      return;
    }

    if (!hasPermission()) {
      emit('onDenied', user, deniedMessage(user));
      return;
    }

    emit('onSignedIn', user);
  }

  function handleSignedOut() {
    // A different account may sign in next, so let activation run again.
    orgActivationTried = false;
    mountSignIn();
    emit('onSignedOut');
  }

  // A one-time sign-in ticket from Clerk (a sign-in token minted for one
  // user), taken out of the URL by the inline script at the top of
  // admin/index.html. Resolves either way: a bad ticket is reported through
  // onTicketFailed and the page falls back to the normal sign-in widget.
  function redeemTicket(Clerk) {
    var ticket = window.__llSignInTicket;
    delete window.__llSignInTicket;
    if (!ticket) return Promise.resolve();

    // Already signed in: there is nothing to redeem it for, and creating a
    // second sign-in alongside an existing session would fail anyway.
    if (Clerk.user) return Promise.resolve();

    return Clerk.client.signIn.create({ strategy: 'ticket', ticket: ticket })
      .then(function (attempt) {
        if (attempt.status !== 'complete' || !attempt.createdSessionId) {
          throw new Error('Clerk needs another step to finish this sign-in (status: ' + attempt.status + ')');
        }
        return Clerk.setActive({ session: attempt.createdSessionId });
      })
      .catch(function (err) {
        var detail = (err && err.errors && err.errors[0] && err.errors[0].longMessage) || (err && err.message) || 'unknown error';
        emit('onTicketFailed', 'That sign-in link did not work (' + detail + '). Links work once and expire quickly, so ask for a new one, or sign in below.');
      });
  }

  function boot() {
    var Clerk = window.Clerk;
    if (!Clerk) {
      emit('onError', 'Clerk did not load. Check the publishable key and frontend API host on this page.');
      return;
    }

    // clerk-js v6 ships without UI components; @clerk/ui is a separate
    // script tag, and it only announces itself by setting this global.
    // clerk-js does NOT pick that global up on its own - it reads the
    // constructor out of load()'s options - so loading both scripts is not
    // enough, and without this hand-off mountSignIn() throws "Clerk was
    // not loaded with Ui components".
    var ClerkUI = window.__internal_ClerkUICtor;
    if (!ClerkUI) {
      emit('onError', 'The Clerk UI components did not load. Check that the @clerk/ui script on this page is reachable and names the same Clerk host as clerk-js.');
      return;
    }

    Clerk.load({ ui: { ClerkUI: ClerkUI } })
      .then(function () { return redeemTicket(Clerk); })
      .then(function () {
        Clerk.addListener(function (resource) {
          if (resource.user) { handleSignedIn(resource.user); } else { handleSignedOut(); }
        });
        if (Clerk.user) { handleSignedIn(Clerk.user); } else { handleSignedOut(); }
      })
      .catch(function (err) {
        emit('onError', 'Clerk failed to initialize: ' + err.message);
      });
  }

  // Test mode: ?as=tanner renders the page as if Tanner Knapp were signed in,
  // without touching Clerk - no session is created and nothing is
  // authenticated, it only lets the signed-in UI be checked. Honoured on
  // localhost and Cloudflare Pages preview hosts (*.pages.dev) only; on the
  // production domain the parameter is ignored and the normal sign-in applies.
  var TEST_USER = {
    id: 'test-tanner-knapp',
    primaryEmailAddress: { emailAddress: 'shadow@shadowdewuff.gay' }
  };

  function testModeRequested() {
    try {
      if (new URLSearchParams(window.location.search).get('as') !== 'tanner') return false;
    } catch (e) { return false; }
    var host = window.location.hostname;
    var allowed = host === 'localhost' || host === '127.0.0.1' || /\.pages\.dev$/.test(host);
    if (!allowed && window.console) {
      console.info('?as=tanner is ignored on ' + host + '; test mode only runs on localhost and *.pages.dev.');
    }
    return allowed;
  }

  var testMode = testModeRequested();

  window.LittleLinkAuth = {
    permission: REQUIRED_PERMISSION,
    organizationId: ORGANIZATION_ID,

    // True when ?as=tanner is active - pages should say so on screen, since
    // what they show is not a real session.
    testMode: testMode,

    // How to name whoever is signed in, for a page that wants to show it.
    describe: describe,

    signOut: function () {
      if (testMode) {
        // There is no Clerk session to end; drop the parameter instead.
        window.location.href = window.location.pathname;
        return;
      }
      if (window.Clerk) { window.Clerk.signOut(); }
    },

    // options.mountTo  - element the sign-in widget is mounted into; this
    //                    module shows and hides it.
    // options.onSignedOut()        - nobody is signed in; widget is up.
    // options.onActivating(user)   - signed in, selecting the organization.
    // options.onSignedIn(user)     - signed in and permitted.
    // options.onDenied(user, msg)  - signed in and refused; msg may be null,
    //                                meaning "lacks the permission".
    // options.onError(message)     - Clerk itself could not be set up.
    // options.onTicketFailed(msg)  - a ?__clerk_ticket= link was rejected;
    //                                the normal sign-in follows.
    start: function (options) {
      options = options || {};
      mountTo = options.mountTo || null;
      handlers = options;

      if (testMode) {
        if (mountTo) { mountTo.hidden = true; }
        emit('onSignedIn', TEST_USER);
        return;
      }

      // The Clerk script tags load async, so window.Clerk is not guaranteed
      // to exist yet when this file (deferred) runs. Waiting for the window
      // load event, the pattern Clerk's own no-framework quickstart uses, is
      // more reliable than racing independently-timed script tags.
      if (document.readyState === 'complete') {
        boot();
      } else {
        window.addEventListener('load', boot);
      }
    }
  };
})();
