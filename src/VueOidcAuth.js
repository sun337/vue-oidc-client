import Vue from 'vue'
import { UserManager, Log, WebStorageStateStore } from 'oidc-client'

/**
 * Indicates the sign in behavior.
 */
export const SignInType = {
  /**
   * Uses the main browser window to do sign-in.
   */
  Window: 0,
  /**
   * Uses a popup window to do sign-in.
   */
  Popup: 1,
  /**
   * Uses a hidden iframe to do sign-in.
   */
  Silent: 2
}

export const LogLevel = {
  NONE: 0,
  ERROR: 1,
  WARN: 2,
  INFO: 3,
  DEBUG: 4
}

export function createOidcAuth(
  authName,
  defaultSignInType,
  appUrl,
  oidcConfig,
  logger = console,
  logLevel = LogLevel.ERROR
) {
  if (!authName) {
    throw new Error('Auth name is required.')
  }
  if (
    defaultSignInType !== SignInType.Window &&
    defaultSignInType !== SignInType.Popup
  ) {
    throw new Error('Only window or popup are valid default signin types.')
  }
  if (!appUrl) {
    throw new Error('App base url is required.')
  }
  if (!oidcConfig) {
    throw new Error('No config provided to oidc auth.')
  }

  Log.level = logLevel
  Log.logger = logger

  // merge config with defaults
  const config = {
    response_type: 'id_token',
    scope: 'openid profile',
    automaticSilentRenew: true,
    userStore: new WebStorageStateStore({
      store: localStorage
    }),
    post_logout_redirect_uri: appUrl,
    ...oidcConfig, // all properties after this are not user configurable
    redirect_uri: `${appUrl}auth/signinwin/${authName}`,
    popup_post_logout_redirect_uri: `${appUrl}auth/signoutpop/${authName}`,
    popup_redirect_uri: `${appUrl}auth/signinpop/${authName}`,
    silent_redirect_uri: `${appUrl}auth/signinsilent/${authName}`
  }

  Log.debug(`Creating new oidc auth as ${authName}`)

  const mgr = new UserManager(config)

  ///////////////////////////////
  // events
  ///////////////////////////////
  mgr.events.addAccessTokenExpiring(() => {
    Log.debug(`${authName} auth token expiring`)
  })

  mgr.events.addAccessTokenExpired(() => {
    Log.debug(
      `${authName} auth token expired, user is authenticated=${
        auth.isAuthenticated
      }`
    )
    auth.user = null
    signInIfNecessary()
    // if (auth.isAuthenticated) {
    //   mgr
    //     .signinSilent()
    //     .then(() => {
    //       Log.debug(`${authName} auth silent signin after token expiration`)
    //     })
    //     .catch(() => {
    //       Log.debug(
    //         `${authName} auth silent signin error after token expiration`
    //       )
    //       signInIfNecessary()
    //     })
    // }
  })

  mgr.events.addSilentRenewError(e => {
    Log.debug(`${authName} auth silent renew error ${e}`)
    // TODO: need to restart renew manually?
    if (auth.isAuthenticated) {
      setTimeout(() => {
        Log.debug(`${authName} auth silent renew retry`)
        mgr.signinSilent()
      }, 5000)
    } else {
      signInIfNecessary()
    }
  })

  mgr.events.addUserLoaded(user => {
    auth.user = user
  })

  mgr.events.addUserUnloaded(() => {
    auth.user = undefined

    // redirect if on protected route (best method here?)
    Log.debug(`${authName} auth user unloaded`)
    signInIfNecessary()
  })

  mgr.events.addUserSignedOut(() => {
    Log.debug(`${authName} auth user signed out`)
    auth.user = null
    signInIfNecessary()
  })

  mgr.events.addUserSessionChanged(user => {
    Log.debug(`${authName} auth user session changed:`, user)
  })

  function signInIfNecessary() {
    if (auth.myRouter) {
      const current = auth.myRouter.currentRoute
      if (current && current.meta.authName === authName) {
        Log.debug(`${authName} auth page re-signin with ${defaultSignInType}`)

        signInReal(defaultSignInType, { state: { current } })
          .then(() => {
            // auth.myRouter()
          })
          .catch(() => {
            setTimeout(signInIfNecessary, 5000)
          })
        // window.location.reload();
        // auth.myRouter.go(); //replace('/');
      }
    }
  }

  function signInReal(type, args) {
    switch (type) {
      case SignInType.Popup:
        return mgr.signinPopup(args)
      case SignInType.Silent:
        return mgr.signinSilent(args)
    }
    return mgr.signinRedirect(args)
  }

  function redirectAfterSignout(router) {
    if (router) {
      const current = router.currentRoute
      if (current && current.meta.authName === authName) {
        router.replace('/')
        return
      }
    }
    //   window.location.reload(true);
    if (appUrl) window.location = appUrl
  }

  let _inited = false
  const auth = new Vue({
    data() {
      return { user: null }
    },
    computed: {
      appUrl() {
        return appUrl
      },
      authName() {
        return authName
      },
      isAuthenticated() {
        return !!this.user && !this.user.expired
      },
      accessToken() {
        return !!this.user && !this.user.expired ? this.user.access_token : ''
      },
      userProfile() {
        return !!this.user && !this.user.expired ? this.user.profile : {}
      }
    },
    methods: {
      startup() {
        const path = window.location.pathname
        let isCB = false
        if (path.indexOf('/signinpop/') > -1) {
          mgr.signinPopupCallback()
          isCB = true
        } else if (path.indexOf('/signinsilent/') > -1) {
          mgr.signinSilentCallback()
          isCB = true
        } else if (path.indexOf('/signoutpop/') > -1) {
          mgr.signoutPopupCallback()
          isCB = true
        }
        if (isCB) return Promise.resolve(0)

        if (_inited) {
          return Promise.resolve(true)
        } else {
          // load user from storage
          return mgr
            .getUser()
            .then(test => {
              _inited = true
              if (test && !test.expired) {
                this.user = test
              }
              return true
            })
            .catch(err => {
              Log.warn(`Auth startup err = ${err}`)
              return false
            })
        }
      },
      useRouter(router) {
        this.myRouter = router
        const guard = (to, from, next) => {
          if (
            to.matched.some(record => record.meta.authName === this.authName)
          ) {
            if (this.isAuthenticated) {
              Log.debug(
                `${authName} auth authenticated user entering protected route ${
                  to.fullPath
                }`
              )
              next()
            } else {
              Log.debug(
                `${authName} auth anon user entering protected route ${
                  to.fullPath
                }`
              )
              signInReal(defaultSignInType, { state: { to } })
                .then(() => {
                  if (defaultSignInType === SignInType.Window) {
                    next(false)
                  } else {
                    next()
                  }
                })
                .catch(() => next(false))
            }
          } else {
            next()
          }
        }
        router.beforeEach(guard)

        router.addRoutes([
          {
            path: `/auth/signinwin/${authName}`,
            name: 'signinwin',
            component: {
              render: h => h('div'),
              created() {
                mgr
                  .signinRedirectCallback()
                  .then(data => {
                    Log.debug(
                      `${authName} Window signin callback success`,
                      data
                    )
                    // need to manually redirect for window type
                    // goto original secure route or root
                    const redirect = data.state ? data.state.to : null
                    if (router) router.replace(redirect || '/')
                    else window.location = appUrl
                  })
                  .catch(err => {
                    Log.error(`${authName} Window signin callback error`, err)
                    if (router) router.replace('/')
                    else window.location = appUrl
                  })
              }
            }
          }
        ])
      },
      signIn(args) {
        return signInReal(defaultSignInType, args)
      },
      signInSilent(args) {
        return signInReal(SignInType.Silent, args)
      },
      signOut(args) {
        if (defaultSignInType === SignInType.Popup) {
          const router = this.myRouter
          return mgr
            .signoutPopup(args)
            .then(() => {
              redirectAfterSignout(router)
            })
            .catch(() => {
              // could be window closed
              redirectAfterSignout(router)
            })
        }
        return mgr.signoutRedirect(args)
      }
    }
  })

  return auth
}
