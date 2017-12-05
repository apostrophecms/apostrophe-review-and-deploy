var _ = require('lodash');
var async = require('async');
var BSON = require('bson');
var bson = new BSON();
var fs = require('fs');
var Promise = require('bluebird');
var zlib = require('zlib');
var cuid = require('cuid');

module.exports = {
  extend: 'apostrophe-pieces',
  name: 'apostrophe-site-review',
  label: 'Review',
  adminOnly: true,
  batchSize: 200,
  rollback: 5,
  moogBundle: {
    modules: [ 'apostrophe-site-review-workflow' ],
    directory: 'lib/modules'
  },

  beforeConstruct: function(self, options) {
    var workflow = options.apos.modules['apostrophe-workflow'];
    if (!workflow) {
      throw new Error('The apostrophe-workflow module must be configured before the apostrophe-site-review module.');
    }

    options.addFields = [
      {
        type: 'string',
        name: 'locale',
        readOnly: true
      },
      {
        type: 'select',
        readOnly: true,
        name: 'status',
        choices: [
          {
            label: 'In Progress',
            value: 'In Progress'
          },
          {
            label: 'Ready to Deploy',
            value: 'Ready to Deploy'
          },
          {
            label: 'Failed',
            value: 'Failed'
          },
          {
            label: 'Deployed',
            value: 'Deployed'
          },
          {
            label: 'Archived',
            value: 'Archived'
          },
        ],
        def: 'In Progress'
      }
    ].concat(options.addFields || []);

    options.removeFields = [ 'tags', 'published', 'siteMapPriority' ];
    options.arrangeFields = [
      {
        name: 'basics',
        label: 'Review',
        fields: [ 'title', 'slug', 'locale', 'status', 'trash' ]
      }
    ].concat(options.arrangeFields || []);
    options.addColumns = [
      {
        name: 'locale',
        label: 'Locale'
      },
      {
        name: 'status',
        label: 'Status',
        partial: function(value) {
          return self.partial('manageStatus', { value: value });
        }
      }
    ].concat(options.addColumns || []);
    options.addFilters = [
      {
        name: 'status'
      }
    ].concat(options.addFilters || []);
    options.removeColumns = [ 'published' ].concat(options.removeColumns || []);
    options.removeFilters = [ 'published' ].concat(options.removeFilters || []);

  },
  
  afterConstruct: function(self) {
    self.excludeFromWorkflow();
    self.addRoutes();
    self.apos.pages.addAfterContextMenu(self.menu);
  },

  construct: function(self, options) {
    var workflow = self.apos.modules['apostrophe-workflow'];
    self.excludeFromWorkflow = function() {
      workflow.excludeTypes.push(self.name);
    };
    self.menu = function(req) {
      if (!req.user) {
        return '';
      }
      return self.partial('menu', { workflowMode: req.session.workflowMode });
    };

    var superPageBeforeSend = self.pageBeforeSend;
    self.pageBeforeSend = function(req, callback) {
      if (!req.user) {
        superPageBeforeSend(req);
        return callback(null);
      }
      return self.getActiveReview(req)
      .then(function(review) {
        req.data.siteReview = req.data.siteReview || {};
        req.data.siteReview.review = review;
        req.data.siteReview.contextDoc = req.data.piece || req.data.page;
        if (req.data.piece) {
          req.data.siteReview.unreviewed = (req.data.piece.siteReviewApproved === null);
        } else if (req.data.page) {
          req.data.siteReview.unreviewed = (req.data.page.siteReviewApproved === null);
        }
        // Call this late so that getCreateSingletonOptions can see the above data
        superPageBeforeSend(req);
        return callback(null);
      })
      .catch(function(err) {
        return callback(err);
      });
    };

    self.addRoutes = function() {
      self.route('post', 'next', self.requireAdmin, function(req, res) {
        return self.getNextDoc(req)
        .then(function(next) {
          if (!next) {
            return res.send({ status: 'done' });
          }
          return res.send({ status: 'ok', next: _.pick(next, 'title', '_id', '_url') });
        });
      });

      self.route('post', 'approve', self.requireAdmin, function(req, res) {
        // TODO if we lower the bar for this from self.requireAdmin, then we'll
        // need to check the permissions properly on the docs
        return self.apos.docs.db.update({
          _id: { $in: self.apos.launder.ids(req.body.ids) },
          siteReviewApproved: { $exists: 1 }
        }, {
          $set: {
            siteReviewApproved: true
          }
        }, {
          multi: true
        })
        .then(function(result) {
          return self.getNextDoc(req);
        })
        .then(function(next) {
          if (next) {
            return next;
          } else {
            return self.getActiveReview(req)
            .then(function(review) {
              review.status = 'Ready to Deploy';
              return self.update(req, review);
            });
          }
        })
        .then(function(doc) {
          if (doc.type === self.name) {
            return res.send({ status: 'Ready to Deploy' });
          } else {
            return res.send({ status: 'ok', next: _.pick(doc, 'title', '_id', '_url') });
          }
        })
        .catch(function(err) {
          console.error('in catch clause', err);
          if (err) {
            console.error(err);
          }
          return res.send({ status: 'error' });
        });
      });

      self.route('post', 'reject', self.requireAdmin, function(req, res) {
        return self.getActiveReview(req)
        .then(function(review) {
          review.status = 'Failed';
          review.rejectedId = self.apos.launder.id(req.body._id);
          return self.update(req, review);
        })
        .then(function() {
          return res.send({ status: 'ok' });
        })
        .catch(function(err) {
          console.error(err);
          return res.send({ status: 'error' });
        });
      });
    };

    // Returns a promise for the next doc ready for review. If `options.notIds` is
    // present, docs whose ids are in that array are skipped.
    self.getNextDoc = function(req, options) {
      var cursor = self.apos.docs.find(req, { siteReviewRank: { $exists: 1 }, siteReviewApproved: null }).sort({ siteReviewRank: 1 }).joins(false).areas(false);
      var nextOptions;
      if (options && options.notIds) {
        cursor.and({ _id: { $nin: options.notIds }});
      }
      return cursor.toObject()
      .then(function(doc) {
        if (!doc) {
          return null;
        }
        if (!doc._url) {
          // Skip anything without a URL
          nextOptions = _.assign({}, options || {}, { notIds: (options.notIds || []).concat([ doc._id ]) });
          return self.getNextDoc(req, nextOptions);
        }
        return doc;
      });
    };

    self.getActiveReview = function(req) {
      return self.find(req, { status: 'In Progress' }).toObject();
    };

    // If a new review is created for a given locale, any review previously "In
    // Progress" or "Ready to Deploy" is now "Superseded."

    self.beforeInsert = function(req, piece, options, callback) {
      piece.locale = workflow.liveify(req.locale);
      return self.apos.docs.db.update({
        type: self.name,
        locale: req.locale,
        status: { $in: [ 'In Progress', 'Ready to Deploy' ] }
      }, {
        $set: {
          status: 'Superseded'
        }
      }, callback);
    };

    // New review in progress. Mark all of the docs in this locale as unreviewed,
    // and give them a sort order.
    self.afterInsert = function(req, piece, options, callback) {
      var order = _.keys(self.apos.docs.managers);
      if (_.includes(order, 'apostrophe-image')) {
        order = _.pull(order, 'apostrophe-image');
        order.push('apostrophe-image');
      }
      if (_.includes(order, 'apostrophe-file')) {
        order = _.pull(order, 'apostrophe-file');
        order.push('apostrophe-file');
      }
      if (_.includes(order, 'apostrophe-global')) {
        order = _.pull(order, 'apostrophe-global');
        order.push('apostrophe-global');
      }
      if (self.options.approvalOrder) {
        order = _.pullAll(order, self.options.approvalOrder);
        order = self.options.approvalOrder.concat(order);
      }
      order = _.uniq(order);
      order = _.invert(order);
      return self.apos.docs.db.find({ workflowLocale: piece.locale, trash: { $ne: true }, published: { $ne: false } }, { type: 1 }).toArray(function(err, docs) {
        // Convert type to the rank of that type
        _.each(docs, function(doc) {
          doc.sortRank = order[doc.type];
        });
        // Sort by type rank, or by id for consistency
        docs.sort(function(a, b) {
          if (a.sortRank < b.sortRank) {
            return -1;
          } else if (a.sortRank > b.sortRank) {
            return 1;
          } else {
            if (a._id < b._id) {
              return -1;
            } else if (a._id > b._id) {
              return 1;
            } else {
              return 0;
            }
          }
        });
        // Note final order where eachLimit will let us see it
        _.each(docs, function(doc, i) {
          doc.sortRank = i;
        });
        return async.eachLimit(docs, 5, function(doc, callback) {
          return self.apos.docs.db.update({
            _id: doc._id
          }, {
            $set: {
              siteReviewRank: doc.sortRank,
              siteReviewApproved: null
            }
          }, callback);
        }, callback);
      });
    };

    self.requireAdmin = function(req, res, next) {
      if (!(req.user && req.user._permissions && req.user._permissions.admin)) {
        return res.send({ status: 'error' });
      }
      return next();
    };

    // Reviews are not subject to workflow (one doesn't commit
    // and export between them, they have no workflowGuid),
    // but they do have a relationship to the current locale:
    // only those for the live version of the current locale
    // should be displayed in the manage view.
    var superFind = self.find;
    self.find = function(req, criteria, projection) {
      return superFind(req, criteria, projection).and({ locale: workflow.liveify(req.locale) }).published(null);
    };

    var superPushAssets = self.pushAssets;
    self.pushAssets = function() {
      superPushAssets();
      self.pushAsset('stylesheet', 'user', { when: 'user' });
    };

    var superGetCreateSingletonOptions = self.getCreateSingletonOptions;
    self.getCreateSingletonOptions = function(req) {
      var object = _.assign(superGetCreateSingletonOptions(req), {
        contextId: req.data.siteReview && req.data.siteReview.contextDoc && req.data.siteReview.contextDoc._id,
        reviewing: !!(req.data.siteReview && req.data.siteReview.review)
      });
      return object;
    };

    // Returns promise that resolves to the name of a gzipped BSON file.
    // Removing that file is your responsibility. The locale exported
    // is the live version of the one specified by `req.locale`.
    // Permissions are not checked.
    
    self.exportLocale = function(req) {
      var locale = workflow.liveify(req.locale);
      var out = zlib.createGzip();
      var fileOut;
      var filename = self.apos.rootDir + '/data/' + locale + '-' + self.apos.utils.generateId() + '.bson.gz';
      var out;
      var offset = 0;
      var ids;
      fileOut = fs.createWriteStream(filename);
      out.pipe(fileOut);
      return self.apos.docs.db.find({ workflowLocale: locale }, { _id: 1 }).toArray()
      .then(function(docs) {
        ids = _.map(docs, '_id');
        // Metadata
        out.write(bson.serialize({ version: 1, ids: ids }));
        return writeUntilExhausted();
      })
      .then(function() {
        return Promise.promisify(out.end, { context: out })();
      })
      .then(function() {
        return filename;
      });

      function writeUntilExhausted() {
        var batch = ids.slice(offset, self.options.batchSize);
        if (!batch.length) {
          return;
        }
        return self.apos.docs.db.find({
          workflowLocale: locale,
          _id: { $in: batch }
        })
        .toArray()
        .then(function(docs) {
          docs.forEach(function(doc) {
            out.write(bson.serialize(doc));
          });
        })
        .then(function() {
          offset += self.options.batchSize;
          if (offset < ids.length) {
            return writeUntilExhausted();
          }
        });
      }
    };

    // Returns promise that resolves when the content stored in the
    // given gzipped BSON file has been restored.
    //
    // To minimize the possibility of users seeing partial or
    // inconsistent data, the content is initially loaded as
    // `localename-importing`, then the locale name is
    // switched to the actual locale name after archiving
    // the previous content of that locale as follows:
    //
    // Any previous content for that locale is moved to the locale
    // `localename-rollback-0`, with content for any previous locale
    // `localename-rollback-n` moved to `localename-rollback-n+1`, discarding
    // content where n is >= `self.options.rollback`.
    //
    // Content is imported to the live version of `req.locale`, regardless of
    // the original locale in the BSON data.
    //
    // Permissions are not checked.
    
    self.importLocale = function(req, filename) {
      var locale = workflow.liveify(req.locale);
      var zin = zlib.createGunzip();
      var fileIn;
      var ids;
      var idsToNew = {};
      var version;
      fileIn = fs.createReadStream(filename);
      fileIn.pipe(zin);

      // read the file, import to temporary locale
      var reader = Promise.promisify(require('read-async-bson'));
      return reader(
        { from: zin },
        function(doc, callback) {
          if (!version) {
            // first object is metadata
            version = doc.version;
            if (typeof(version) !== 'number') {
              return callback(new Error('The first BSON object in the file must contain version and ids properties'));
            }
            if (version < 1) {
              return callback(new Error('Invalid version number'));
            }
            if (version > 1) {
              return callback(new Error('This file came from a newer version of apostrophe-site-review, I don\'t know how to read it'));
            }
            ids = doc.ids;
            if (!Array.isArray(ids)) {
              return callback(new Error('The first BSON object in the file must contain version and ids properties'));
            }
            _.each(ids, function(id) {
              idsToNew[id] = cuid();
            });
            return callback(null);
          } else {
            // Iterator, invoked once per doc
            doc.workflowLocale = locale + '-importing';
            if (doc.workflowLocaleForPathIndex) {
              doc.workflowLocaleForPathIndex = doc.workflowLocale;
            }
            replaceIdsRecursively(doc);
            
            return self.apos.docs.db.insert(doc, callback);
          }
        }
      )
      .then(function() {
        // Rename locale-rollback-0 to locale-rollback-1, etc.
        var n = 0;
        return archiveNext();
        function archiveNext() {
          if (n >= self.options.rollback) {
            return;
          }
          return self.apos.docs.db.update(
            {
              workflowLocaleForPathIndex: locale + '-rollback-' + n
            }, {
              $set: {
                workflowLocaleForPathIndex: locale + '-rollback-' + (n + 1)
              }
            },
            {
              multi: true
            }
          )
          .then(function() {
            return self.apos.docs.db.update(
              {
                workflowLocale: locale + '-rollback-' + n
              }, {
                $set: {
                  workflowLocale: locale + '-rollback-' + (n + 1)
                }
              },
              {
                multi: true
              }
            );
          })
          .then(function() {
            n++;
            return archiveNext();
          });
        }
      })
      .then(function() {
        // Purge stuff we no longer keep for rollback.
        //
        // In theory `rollback` could have been a really big number once
        // and set smaller later. In practice set a reasonable bound
        // so this is a single, fast call.
        var locales = _.map(_.range(self.options.rollback, 100), function(i) {
          return locale + '-rollback-' + i
        });
        return self.apos.docs.db.remove({
          workflowLocale: { $in: locales }
        });
      })
      .then(function() {
        // Showtime. This has to be as fast as possible.
        //
        // If we're keeping old deployments for rollback,
        // rename the currently live locale to localename-rollback-0,
        // otherwise discard it
        if (self.options.rollback) {
          return self.apos.docs.db.update({
            workflowLocale: locale
          },
          {
            $set: {
              workflowLocale: locale + '-rollback-0'
            }
          }, {
            multi: true
          })
          .then(function() {
            // workflowLocaleForPathIndex is a separate property, not always present,
            // so we are stuck with a second call
            return self.apos.docs.db.update({
              workflowLocaleForPathIndex: locale
            },
            {
              $set: {
                workflowLocaleForPathIndex: locale + '-rollback-0'
              }
            }, {
              multi: true
            })
          });
        } else {
          return self.apos.docs.remove({
            workflowLocale: locale
          });
        }
      })
      .then(function() {
        // Showtime, part 2.
        //
        // rename the temporary locale to be the live locale.
        // Do workflowLocaleForPathIndex first to minimize
        // possible inconsistent time
        return self.apos.docs.db.update({
          workflowLocaleForPathIndex: locale + '-importing'
        }, {
          $set: {
            workflowLocaleForPathIndex: locale
          }
        }, {
          multi: true
        });
      })
      .then(function() {
        return self.apos.docs.db.update({
          workflowLocale: locale + '-importing'
        }, {
          $set: {
            workflowLocale: locale
          }
        }, {
          multi: true
        });
      });

      // Recursively replace all occurrences of the ids in this locale
      // found in the given doc with their new ids per `idsToNew`. This prevents
      // _id conflicts on insert, even though old data is still in the database
      // under other locale names

      function replaceIdsRecursively(doc) {
        _.each(doc, function(val, key) {
          if ((typeof(val) === 'string') && (val.length < 100)) {
            if (idsToNew[val]) {
              doc[key] = idsToNew[val];
            }
          } else if (val && (typeof(val) === 'object')) {
            replaceIdsRecursively(val);
          }
        });
      }

    };

  }
};
