(function(module) {


  var	user = module.parent.require('./user'),
    Groups = module.parent.require('./groups'),
    meta = module.parent.require('./meta'),
    SocketAdmin = module.parent.require('./socket.io/admin').plugins,
    db = module.parent.require('./database'),
    async = require('async'),
    passport = module.parent.require('passport'),
    PassportEveOnlineSSO = require('passport-eveonline-sso').Strategy,
    nconf = module.parent.require('nconf'),
    winston = module.parent.require('winston'),
    https = module.parent.require('https'),
    helpers = module.parent.require('./routes/helpers'),
    app;

  var authenticationController = module.parent.require('./controllers/authentication');

  var constants = Object.freeze({
    'name': 'EVE Online',
    'admin': {
      'route': '/plugins/sso-eveonline',
      'icon': 'fa-table'
    }
  });

  var EveOnlineSSO = {};

  // Hook: onLoad
  EveOnlineSSO.onLoad = function(application, callback) {
    // Load settings onLoad should make them available for all other methods
    if (!EveOnlineSSO.settings) {
      return EveOnlineSSO.getSettings(function() {
        EveOnlineSSO.onLoad(application, callback);
      });
    }

    // Setup routing
    application.router.get('/admin/plugins/sso-eveonline', application.middleware.admin.buildHeader, EveOnlineSSO.renderAdmin);
    application.router.get('/api/admin/plugins/sso-eveonline', EveOnlineSSO.renderAdmin);
    helpers.setupPageRoute(application.router, '/auth/eveonline/error', application.middleware, [], EveOnlineSSO.renderError);

    // Setup sockets for admin panel
    SocketAdmin.EveOnlineSSO = {
      createGroupMapping: EveOnlineSSO.createGroupMapping,
      deleteGroupMapping: EveOnlineSSO.deleteGroupMapping,
      getAllGroupMappings: EveOnlineSSO.getAllGroupMappings
    };

    app = application.app;

    // Done
    callback();
  };

  // Hook: Add menu item to Social Authentication admin menu
  EveOnlineSSO.addMenuItem = function(nav, callback) {
    nav.authentication.push({
      'route' : constants.admin.route,
      'icon'  : constants.admin.icon,
      'name'  : constants.name
    });

    callback(null, nav);
  };

  // Hook: Render an error page
  EveOnlineSSO.renderError = function(req, res, next) {
    var data = {
      title: (EveOnlineSSO.settings.frontendName || constants.name) + ' Login Error',
      supportMessage: EveOnlineSSO.settings.supportMessage
    };

    res.render('client/sso-eveonline-error', data);
  };

  // Hook: Render admin panel
  EveOnlineSSO.renderAdmin = function(req, res, next) {
    async.parallel({
      groupMappings: function(callback) {
        getAllGroupMappings(callback);
      },
      groups: function(callback) {
        Groups.getGroupsFromSet('groups:visible:name', 0, 0, -1, callback);
      }
    }, function(err, result) {
      res.render('admin/plugins/sso-eveonline', result);
    });
  };

  // Load settings
  EveOnlineSSO.getSettings = function(callback) {
    if (EveOnlineSSO.settings) {
      return callback();
    }

    meta.settings.get('sso-eveonline', function(err, settings) {
      winston.verbose('[plugin-sso-eveonline] Loaded Settings');

      EveOnlineSSO.settings = settings;
      callback();
    });
  };

  EveOnlineSSO.completeProfile = function(profile, accessToken, refreshToken, callback) {
    if (!profile.CharacterID || !profile.CharacterName || !profile.CharacterOwnerHash) {
      return callback(new Error('No chracter information provided. If logging in via Steam or Facebook, be sure to associate a character with this login.'));
    }

    async.waterfall([
      // get character info
      function (next) {
        profile.CharacterPortrait = '//image.eveonline.com/Character/' + profile.CharacterID + '_256.jpg';

        https.get({
          hostname: 'esi.tech.ccp.is',
          port: 443,
          path: '/latest/characters/' + profile.CharacterID + '/'
        }, function (res) {
          if (res.statusCode !== 200) {
            return next(new Error('Unable to find your character information. Contact forum support.'));
          }

          var responseData = '';

          res.on('data', function (data) {
            responseData += data;
          });

          res.on('error', function (err) {
            return next(new Error('Unable to find your character information. Contact forum support.'));
          });

          res.on('end', function() {
            var body = JSON.parse(responseData);

            profile.CorporationID = body.corporation_id;
            profile.AllianceID = body.alliance_id || null;
            profile.CorporationIcon = '//image.eveonline.com/Corporation/' + profile.CorporationID + '_256.jpg';
            if(profile.AllianceID === null){
              profile.AllianceIcon = '//imageserver.eveonline.com/Corporation/1_256.png';
            }else{
              profile.AllianceIcon = '//image.eveonline.com/Alliance/' + profile.AllianceID + '_256.jpg' ;
            };

            next(null, profile);
          });
        });
      },
      // get corporation info
      function (profile, next) {
        https.get({
          hostname: 'esi.tech.ccp.is',
          port: 443,
          path: '/latest/corporations/' + profile.CorporationID + '/'
        }, function (res) {
          if (res.statusCode !== 200) {
            return next(new Error('Unable to find your character corporation information. Contact forum support.'));
          }

          var responseData = '';

          res.on('data', function (data) {
            responseData += data;
          });

          res.on('error', function (err) {
            return next(new Error('Unable to find your character corporation information. Contact forum support.'));
          });

          res.on('end', function() {
            var body = JSON.parse(responseData);

            profile.CorporationName = body.name;

            next(null, profile);
          });
        });
      },
      function (profile, next) {
        https.get({
          hostname: 'esi.tech.ccp.is',
          port: 443,
          path: '/latest/characters/' + profile.CharacterID + '/titles/',
          headers:{
            Authorization: 'Bearer ' + accessToken
          }
        }, function (res) {
          if (res.statusCode !== 200) {
            return next(new Error('Unable to find your character title information. Contact forum support.'));
          }

          var responseData = '';

          res.on('data', function (data) {
            responseData += data;
          });

          res.on('error', function (err) {
            return next(new Error('Unable to find your character title information. Contact forum support.'));
          });

          res.on('end', function() {
            var titles = JSON.parse(responseData);

            profile.Titles = titles || [];

            next(null, profile);
          });
        });
      }
    ], callback);
  }

  // Hook: passport strategy
  EveOnlineSSO.getStrategy = function(strategies, callback) {

    if (
      EveOnlineSSO.settings !== undefined &&
      EveOnlineSSO.settings.hasOwnProperty('clientId') && EveOnlineSSO.settings.clientId &&
      EveOnlineSSO.settings.hasOwnProperty('clientSecret') && EveOnlineSSO.settings.clientSecret
    ) {
      // Define passport
      passport.use(new PassportEveOnlineSSO({
        clientID: EveOnlineSSO.settings.clientId,
        clientSecret: EveOnlineSSO.settings.clientSecret,
        scope: 'esi-characters.read_titles.v1',
        callbackURL: nconf.get('url') + '/auth/eveonline/callback',
        failureUrl: nconf.get('url') + '/auth/eveonline/error',
        passReqToCallback: true
      }, function (req, accessToken, refreshToken, profile, done) {
        EveOnlineSSO.completeProfile(profile, accessToken, refreshToken, function (err, profile) {
          if (err) {
            return done(err);
          }

          var eveonlinessoid = 'character_' + profile.CharacterID + '-' + profile.CharacterOwnerHash;

          console.log('eveonlinessoid', eveonlinessoid);

          // If user is already logged in
          if (req.hasOwnProperty('user') && req.user.hasOwnProperty('uid') && req.user.uid > 0) {
            // Save Eve Seat specific information to the user
            user.setUserField(req.user.uid, 'eveonlinessoid', eveonlinessoid);
            db.setObjectField('eveonlinessoid:uid', eveonlinessoid, req.user.uid);

            EveOnlineSSO.storeTokens(req.user.uid, accessToken, refreshToken);

            return done(null, req.user);
          }

          // Login the user
          EveOnlineSSO.login(eveonlinessoid, profile, accessToken, refreshToken, function(err, user) {
            if (err) {
              return done(err);
            }

            // Store settings
            EveOnlineSSO.storeTokens(user.uid, accessToken, refreshToken);
            EveOnlineSSO.updateProfile(user.uid, eveonlinessoid, profile, function(err, result) {

              authenticationController.onSuccessfulLogin(req, user.uid);

              done(null, user);
            });
          });
        });
      }));

      strategies.push({
        name: 'eveonline-sso',
        url: '/auth/eveonline',
        icon: constants.admin.icon,
        scope: 'esi-characters.read_titles.v1',
        callbackURL: '/auth/eveonline/callback',
        failureUrl: '/auth/eveonline/error'
      });
    }

    callback(null, strategies);
  };

  //login from strategy
  EveOnlineSSO.login = function(eveonlinessoid,profile,accessToken,refreshToken,callback){
  	//search for the user
  	EveOnlineSSO.getUidByEveOnlineSsoId(eveonlinessoid,function(err,uid){
  		if (err) {
  			return callback(err)
  		}

  		if (uid !== null) {
  			//existing user
  			winston.verbose('[plugin-sso-eveonline] Logging in User via plugin-sso-eveonline' + uid)

  			callback(null,{
  				uid:uid
  			})
  		} else{
  			//new user
  			winston.verbose('[plugin-sso-eveonline] Create New User via plugin-sso-eveonline' + profile.CharacterName)

  			user.create({username: profile.CharacterName},function(err,uid){
  				if(err){
  					return callback(err)
  				}

  				// Save Eve Online SSO specific information to the user
  				user.setUserField(uid, 'eveonlinessoid'  ,eveonlinessoid)
  				db.setObjectField('eveonlinessoid:uid',eveonlinessoid,uid)

  				callback(null,{
  					uid:uid
  				})
  			})
  		}
  	})
  }

  // Simple array diff function
  Array.prototype.diff = function(a) {
    return this.filter(function(i) { return (a.indexOf(i) > -1) === false; });
  };

  // Update the user profile when logging in
  EveOnlineSSO.updateProfile = function(uid, eveonlinessoid, profile, callback) {
    async.waterfall([
      function (next) {
        user.setUserField(uid, 'fullname', profile.CharacterName, next);
      },
      function (next) {
        user.setUserField(uid, 'uploadedpicture', profile.CharacterPortrait, next);
      },
      function (next) {
        user.setUserField(uid, 'picture', profile.AllianceIcon, next);
      },
      function (next) {
        user.setUserField(uid, 'eveonlinessoid', eveonlinessoid, next);
      },
      function (next) {
        user.setUserField(uid, 'corporation', profile.CorporationIcon, uid, next);
      },
      function (next) {
        user.setUserField(uid, 'alliance', profile.AllianceIcon, uid, next);
      },
      function (next) {
        db.setObjectField('eveonlinessoid:uid', eveonlinessoid, uid, next);
      },
      function (next) {
        if (EveOnlineSSO.settings.mapGroups === 'on') {
          EveOnlineSSO.syncUserGroups(uid, profile.CorporationName, profile.Titles, next);
        } else {
          next();
        }
      }
    ], callback);
  };

  // Syncs user to forum groups
  EveOnlineSSO.syncUserGroups = function(uid, corporationName, titles, callback) {
    async.parallel({
      groupMappings: function(next) {
        getAllGroupMappings(next);
      },
      userGroups: function(next) {
        Groups.getUserGroupsFromSet('groups:createtime', [uid], next);
      }
    },
    function(err, results) {
      var mappedGroupSlugs = [];
      var currentGroupSlugs = [];

      // Profile titles to group mapping
      titles.forEach(function(title) {
        results.groupMappings.forEach(function(groupMapping) {
          if (groupMapping.corporationName === corporationName && groupMapping.title === title.name) {
            mappedGroupSlugs.push(groupMapping.groupSlug);
          }
        });
      });

      // Profile corporation without title
      results.groupMappings.forEach(function(groupMapping) {
        if (groupMapping.corporationName === corporationName && groupMapping.title === '') {
          mappedGroupSlugs.push(groupMapping.groupSlug);
        }
      });

      // Current user Groups
      results.userGroups[0].forEach(function(group) {
        if (!Groups.isPrivilegeGroup(group.name) && group.name !== 'registered-users') {
          currentGroupSlugs.push(group.slug);
        }
      });

      // Diff groups
      var groupsToLeave = currentGroupSlugs.diff(mappedGroupSlugs);
      var groupsToJoin = mappedGroupSlugs.diff(currentGroupSlugs);

      // Exclude administrators
      let index = groupsToLeave.indexOf('administrators');
      if (index > -1) {
         groupsToLeave.splice(index, 1);
      }

      if (groupsToLeave.length > 0) {
        winston.verbose('[plugin-sso-eveonline] Leaving Groups: ' + groupsToLeave);

        // Leave Groups
        groupsToLeave.forEach(function(groupSlug) {
          Groups.getGroupNameByGroupSlug(groupSlug, function(err, groupName) {
            if (groupName) {
              Groups.leave(groupName, uid);
            }
          });
        });
      }

      if (groupsToJoin.length > 0) {
        winston.verbose('[plugin-sso-eveonline] Joining Groups: ' + groupsToJoin);

        // Join Groups
        groupsToJoin.forEach(function(groupSlug) {
          Groups.getGroupNameByGroupSlug(groupSlug, function(err, groupName) {

            if (groupName) {
              Groups.join(groupName, uid);
            }
          });
        });
      }

      callback();
    });
  };

  // Store Tokens for future use
  EveOnlineSSO.storeTokens = function(uid, accessToken, refreshToken) {
    user.setUserField(uid, 'evesonlinessoaccesstoken', accessToken);
    user.setUserField(uid, 'evesonlinessorefreshtoken', refreshToken);
  };

  

  // Get UID
  EveOnlineSSO.getUidByEveOnlineSsoId = function(eveonlinessoid, callback) {
    db.getObjectField('eveonlinessoid:uid', eveonlinessoid, function(err, uid) {
      if (err) {
        return callback(err);
      }

      callback(null, uid);
    });
  };

  // Hook to delete user data when user is deleted
  EveOnlineSSO.deleteUserData = function(uid, callback) {
    async.waterfall([
      async.apply(user.getUserField, uid.uid, 'eveonlinessoid'),
        function(oAuthIdToDelete, next) {
          winston.verbose('[plugin-sso-evesonline] Deleting OAuthId data for uid ' + uid.uid + '. oAuthIdToDelete: ' + oAuthIdToDelete);

          db.deleteObjectField('eveonlinessoid:uid', oAuthIdToDelete, next);
      	}
    ], function(err) {
      if (err) {
        winston.verbose('[plugin-sso-evesonline] Could not remove OAuthId data for uid ' + uid.uid + '. Error: ' + err);

        return callback(err);
      }

      callback(null, uid);
    });
  };

  // Get association for account screen
  EveOnlineSSO.getAssociation = function(data, callback) {
    user.getUserField(data.uid, 'eveonlinessoid', function(err, eveOnlineSsoId) {
      if (err) {
        return callback(err, data);
      }

      if (eveOnlineSsoId) {
        data.associations.push({
          associated: true,
          url: EveOnlineSSO.settings.baseUri,
          name: EveOnlineSSO.settings.frontendName || constants.name,
          icon: constants.admin.icon
        });
      } else {
        data.associations.push({
          associated: false,
          url: nconf.get('url') + '/auth/eveonline',
          name: EveOnlineSSO.settings.frontendName || constants.name,
          icon: constants.admin.icon
        });
      }

      callback(null, data);
    });
  };

  // Socket to delete group mapping
  EveOnlineSSO.createGroupMapping = function(socket, data, callback) {
    createGroupMapping(data, callback);
  };

  // Socket to delete group mapping
  EveOnlineSSO.deleteGroupMapping = function(socket, mappingId, callback) {
    deleteGroupMapping(mappingId, callback);
  };

  // Socket to get all group mappings
  EveOnlineSSO.getAllGroupMappings = function(socket, data, callback) {
    getAllGroupMappings(callback);
  };

  // Create group mapping
  function createGroupMapping(data, callback) {
    if (!data || !data.hasOwnProperty('corporationName') || !data.hasOwnProperty('title') || !data.hasOwnProperty('groupSlug') || data.groupSlug === '') {
      return callback(new Error('empty-data'));
    }

    db.incrObjectField('global', 'nextEveOnlineSSOMappingId', function(err, mappingId) {
      if (err) {
        return callback(err);
      }

      var mapping = {
        mappingId: mappingId,
        corporationName: data.corporationName,
        title: data.title,
        groupSlug: data.groupSlug
      };

      async.parallel({
        mappingId: function(next) {
          db.setObject('plugin-sso-eveonline:group-mapping:' + mappingId, mapping, next(err, mappingId));
        },
        whatever : function(next) {
          db.setAdd('plugin-sso-eveonline:group-mappings', mappingId, next(err, mappingId));
        }
      }, callback);
    });
  }

  // Removed group mapping data
  function deleteGroupMapping(mappingId, callback) {
    async.parallel([
      function(next) {
        db.setRemove('plugin-sso-eveonline:group-mappings', mappingId, next);
      },
      function(next) {
        db.delete('plugin-sso-eveonline:group-mapping' + mappingId, next);
      }
    ], callback);
  }

  // Get all group mapping data
  function getAllGroupMappings(callback) {
    db.getSetMembers('plugin-sso-eveonline:group-mappings', function(err, mappingIds) {
      var mappings = [];

      async.each(mappingIds, function(mappingId, next) {
        db.getObject('plugin-sso-eveonline:group-mapping:' + mappingId, function(err, mapping) {
          Groups.getGroupNameByGroupSlug(mapping.groupSlug, function(err, groupName) {

            // Group for mapping not found, remove the mapping
            if (err || !groupName) {
              deleteGroupMapping(mapping.mappingId, null);

            // Set groupName
            } else {
              mapping.groupName = groupName;
              mappings.push(mapping);
            }

            next();
          });
        });
      }, function(err) {
        callback(err, mappings);
      });
    });
  }

  module.exports = EveOnlineSSO;

}(module));