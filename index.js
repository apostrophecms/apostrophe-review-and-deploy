var _ = require('lodash');
var async = require('async');
var BSON = require('bson');
var bson = new BSON();
var fs = require('fs');
var Promise = require('bluebird');
var zlib = require('zlib');
var cuid = require('cuid');
var request = require('request-promise');
var expressBearerToken = require('express-bearer-token')();

module.exports = {
  extend: 'apostrophe-pieces',
  name: 'apostrophe-review-and-deploy',
  label: 'Review',
  adminOnly: true,
  batchSize: 200,
  rollback: 5,
  sendAttachmentConcurrency: 3,
  moogBundle: {
    modules: [ 'apostrophe-review-and-deploy-workflow' ],
    directory: 'lib/modules'
  },

  beforeConstruct: function(self, options) {
    var workflow = options.apos.modules['apostrophe-workflow'];
    if (!workflow) {
      throw new Error('The apostrophe-workflow module must be configured before the apostrophe-review-and-deploy module.');
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
          }
        ],
        def: 'In Progress'
      }
    ].concat(options.addFields || []);

    options.removeFields = [ 'tags', 'published' ];
    options.arrangeFields = [
      {
        name: 'basics',
        label: 'Review',
        fields: [ 'title', 'slug', 'deployTo', 'locale', 'status', 'trash' ]
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
  
  afterConstruct: function(self, callback) {
    self.composeDeployTo();
    self.excludeFromWorkflow();
    self.addRoutes();
    self.apos.pages.addAfterContextMenu(self.menu);
    self.addCsrfExceptions();
    return self.ensureIndexes(callback);
  },

  construct: function(self, options) {
    var workflow = self.apos.modules['apostrophe-workflow'];
    self.excludeFromWorkflow = function() {
      workflow.excludeTypes.push(self.name);
      workflow.excludeProperties.push('siteReviewRank', 'siteReviewApproved');
    };
    self.menu = function(req) {
      if (!self.isAdmin(req)) {
        return '';
      }
      return self.partial('menu', { workflowMode: req.session.workflowMode });
    };

    var superPageBeforeSend = self.pageBeforeSend;
    self.pageBeforeSend = function(req, callback) {
      if (!self.isAdmin(req)) {
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

      self.route('post', 'modified', self.requireAdmin, function(req, res) {
        var ids = self.apos.launder.ids(req.body.ids);
        return self.getLastDeployedReview(req)
        .then(function(deployed) {
          return Promise.map(ids, function(id) {
            return workflow.db.findOne({ toId: id, createdAt: { $gte: deployed.createdAt } });
          });
        })
        .then(function(maybeCommits) {
          if (_.find(maybeCommits, function(commit) {
            return !!commit;
          })) {
            return res.send({ status: 'ok', modified: true });  
          } else {
            return res.send({ status: 'ok', modified: false });  
          }
        })
        .catch(function(err) {
          console.error(err);
          return res.send({ status: 'error' });
        });
      });
    
      self.route('post', 'approve', self.requireAdmin, function(req, res) {
        // TODO if we lower the bar for this from self.requireAdmin, then we'll
        // need to check the permissions properly on the docs
        var review;
        var ids = self.apos.launder.ids(req.body.ids);
        return self.getActiveReview(req)
        .then(function(r) {
          review = r;
        })
        .then(function() {
          return self.apos.docs.db.update({
            _id: { $in: ids },
            siteReviewApproved: { $exists: 1 }
          }, {
            $set: {
              siteReviewApproved: true
            }
          }, {
            multi: true
          })
        })
        .then(function() {
          return self.apos.docs.db.update({
            _id: review._id
          }, {
            $inc: {
              reviewed: ids.length
            }
          });
        })
        .then(function() {
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
    
      self.route('get', 'attachments', self.deployPermissions, function(req, res) {
        return self.apos.attachments.db.find({}).toArray()
        .then(function(attachments) {
          return res.send(attachments);
        })
        .catch(function(e) {
          console.error(e);
          res.status(500).send('error');
        });
      });
    
      // Accept information about new attachments (`inserts`),
      // and new crops of attachments we already have (`crops`).
      // This should be preceded by the use of /attachments/upload to
      // sync individual files before the metadata appears in the db,
      // leading to their possible use
    
      self.route('post', 'attachments', self.deployPermissions, function(req, res) {
        if (!Array.isArray(req.body.inserts)) {
          return res.status(400).send('bad request');
        }
        var inserts = req.body.inserts;
        _.each(inserts, function(attachment) {
          if ((!attachment) || (!attachment._id)) {
            return res.status(400).send('bad request');
          }
        });
        var newCrops = req.body.newCrops;
        if (!Array.isArray(newCrops)) {
          return res.status(400).send('bad request');
        }
        var newlyVisibles = self.apos.launder.ids(req.body.newlyVisibles);
        _.each(newCrops, function(cropInfo) {
          if (typeof(cropInfo._id) !== 'string') {
            return res.status(400).send('bad request');
          }
          if (typeof(cropInfo.crop) !== 'object') {
            return res.status(400).send('bad request');
          }
        });
        var insertStep;
        if (inserts.length) {
          insertStep = self.apos.attachments.db.insert(inserts);
        } else {
          insertStep = Promise.resolve(true);
        }
        return insertStep.then(function() {
          return Promise.map(newCrops, function(cropInfo) {
            return self.apos.attachments.db.update({
              _id: cropInfo._id,
              $push: {
                crops: cropInfo.crop
              }
            });
          });
        })
        .then(function() {
          return self.apos.attachments.db.update({
            _id: { $in: newlyVisibles }
          }, {
            $set: {
              trash: false
            }
          }, {
            multi: true
          });
        })
        .then(function() {
          return res.status(200).send('ok');
        })
        .catch(function(e) {
          console.error(e);
          return res.status(500).send('error');
        });
      });
    
      // Accept a single file at a specified uploadfs path
      self.route('post', 'attachments/upload', self.apos.middleware.files, self.deployPermissions, function(req, res) {
        var copyIn = Promise.promisify(self.apos.attachments.uploadfs.copyIn);
        var metadata;
        var file;
        try {
          file = req.files.file;
          if (!file) {
            throw new Error('no file');
          }
          // uploadfs path is in a separate argument in case middleware
          // "helpfully" launders off too much of it
          path = self.apos.launder.string(req.body.path);
          if (path.match(/\.\./)) {
            throw new Error('sneaky');
          }
        } catch (e) {
          return res.status(400).send('bad request');
        }
        return copyIn(file.path, path)
        .then(function() {
          return res.status(200).send('ok');
        })
        .catch(function(e) {
          console.error(e);
          res.status(500).send('error');
        });
      });
    
      // UI route to initiate a deployment. Replies with `{ jobId: nnn }`,
      // suitable for calling `apos.modules['apostrophe-jobs'].progress(jobId)`.

      self.route('post', 'deploy', self.requireAdmin, function(req, res) {

        var locale = workflow.liveify(req.locale);

        var deployToArray = self.getDeployToArrayForCurrentLocale(req);

        return self.apos.modules['apostrophe-jobs'].runNonBatch(req, run, {
          label: 'Deploying'
        });

        function run(req, reporting) {
          reporting.setTotal(4 * deployToArray.length);
          return Promise.map(deployToArray, function(deployTo) {
            var filename;
            var options = {
              deployTo: deployTo
            };
            reporting.good();
            return Promise.try(function() {
              return self.deployAttachments(options);
            })
            .then(function() {
              reporting.good();
              return self.exportLocale(req)
            })
            .then(function(_filename) {
              reporting.good();
              filename = _filename;
              return self.remoteApi('locale', {
                method: 'POST',
                json: true,
                formData: {
                  locale: locale,
                  file: fs.createReadStream(filename)
                }
              }, options);
            })
            .then(function(result) {
              reporting.good();
              return monitorUntilDone();
    
              function monitorUntilDone() {
                return self.remoteApi('locale/progress', {
                  method: 'POST',
                  json: true,
                  body: {
                    jobId: result.jobId
                  }
                }, options)
                .then(function(job) {
                  if (job.status === 'completed') {
                    return;
                  } else if (job.status === 'failed') {
                    throw new Error('upload of locale failed');
                  } else {
                    return Promise.delay(250).then(function() {
                      return monitorUntilDone();
                    });
                  }
                });
              }
            })
            .finally(function(r) {
              if (filename) {
                fs.unlinkSync(filename);
              }
            });
          })
          .then(function(results) {
            return self.apos.docs.db.update({
              type: self.name,
              locale: locale,
              status: 'Ready to Deploy'
            }, {
              $set: {
                status: 'Deployed'
              }
            }, {
              multi: 1
            });
          })
          .catch(function(err) {
            reporting.bad();
            throw err;
          });
        }
      });
    
      self.route('post', 'locale', self.deployPermissions, self.apos.middleware.files, function(req, res) {
        var locale = self.apos.launder.string(req.body.locale);
        var file = req.files && req.files.file;
        if (!(locale && file)) {
          return res.status(400).send('bad request');
        }
        return self.apos.modules['apostrophe-jobs'].runNonBatch(req, run, {
          label: 'Receiving'
        });
        function run(req, reporting) {
          return self.importLocale(req, file.path);
        }
      });
    
      // The regular job-monitoring route is CSRF protected and
      // it renders markup we don't care about. Provide our own
      // access to the job object. TODO: think about whether
      // this should be a standard route of `apostrophe-jobs`.
      self.route('post', 'locale/progress', self.deployPermissions, function(req, res) {
        var jobId = self.apos.launder.string(req.body.jobId);
        if (!jobId) {
          return res.status(400).send('bad request');
        }
        return self.apos.modules['apostrophe-jobs'].db.findOne({ _id: jobId })
        .then(function(job) {
          if (job) {
            return res.send(job);
          }
          return res.status(404).send('job missing');
        })
        .catch(function(e) {
          console.error(e);
          return res.status(500).send('error');
        });
      });
    };

    self.addCsrfExceptions = function() {
      self.apos.on('csrfExceptions', function(list) {
        list.push(self.action + '/locale');
        list.push(self.action + '/locale/progress');
        list.push(self.action + '/deploy');
        list.push(self.action + '/attachments');
        list.push(self.action + '/attachments/upload');
      });
    };

    // Returns a promise for the next doc ready for review.
    self.getNextDoc = function(req) {
      options = options || {};
      var cursor = self.apos.docs.find(req, { siteReviewRank: { $exists: 1 }, siteReviewApproved: null }).sort({ siteReviewRank: 1 }).log(true).joins(false).areas(false);
      return cursor.toObject()
      .then(function(doc) {
        if (!doc) {
          return null;
        }
        if (!doc._url) {
          // Skip anything without a URL
          return self.apos.docs.db.update({
            _id: doc._id
          }, {
            $set: {
              siteReviewApproved: true
            }
          }).then(function() {
            return self.getActiveReview(req)
          })
          .then(function(review) {
            return self.apos.docs.db.update({
              _id: review._id
            }, {
              $inc: {
                reviewed: 1
              }
            });
          })
          .then(function() {
            return self.getNextDoc(req);
          });
        }
        return doc;
      });
    };

    self.getActiveReview = function(req) {
      return self.find(req, { status: 'In Progress' }).toObject();
    };

    self.getLastDeployedReview = function(req) {
      return self.find(req, { status: 'Deployed' }).sort({ createdAt: -1 }).toObject();
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
      }, {
        multi: true
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
        return async.series([
          setTotal,
          storeRanks
        ], callback);
        function setTotal(callback) {
          return self.apos.docs.db.update({
            _id: piece._id
          }, {
            $set: {
              total: docs.length,
              reviewed: 0
            }
          }, callback);
        }
        function storeRanks(callback) {
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
        }
      });
    };

    self.requireAdmin = function(req, res, next) {
      if (!self.isAdmin(req)) {
        return res.send({ status: 'error' });
      }
      return next();
    };

    self.isAdmin = function(req) {
      return req.user && req.user._permissions && req.user._permissions.admin;
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
        var batch = ids.slice(offset, offset + self.options.batchSize);
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

      return Promise.try(function() {
        // Remove any leftover failed attempt at a previous import
        // so we don't get duplicate junk if this one succeeds
        return self.apos.docs.db.remove({
          workflowLocale: locale + '-importing'
        });
      })
      .then(function() {
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
                return callback(new Error('This file came from a newer version of apostrophe-review-and-deploy, I don\'t know how to read it'));
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
        );
      })
      .then(function() {
        // Rename locale-rollback-0 to locale-rollback-1, etc.
        var n = self.options.rollback || 0;
        return archiveNext();
        function archiveNext() {
          var cleanStep;
          if (n === 0) {
            return;
          }
          if (n === self.options.rollback) {
            // If the max is 5 and rollback-5 already exists,
            // we'll be dropping 4 on top of an existing 5,
            // leading to collisions in the index. Remove
            // the old 5 first
            cleanStep = self.apos.docs.db.remove({
              workflowLocale: locale + '-rollback-' + n
            });
          } else {
            cleanStep = Promise.resolve(true);
          }
          return cleanStep
          .then(function() {
            return self.apos.docs.db.update(
              {
                workflowLocaleForPathIndex: locale + '-rollback-' + (n - 1)
              }, {
                $set: {
                  workflowLocaleForPathIndex: locale + '-rollback-' + n
                }
              },
              {
                multi: true
              }
            )
          })
          .then(function() {
            return self.apos.docs.db.update(
              {
                workflowLocale: locale + '-rollback-' + (n - 1)
              }, {
                $set: {
                  workflowLocale: locale + '-rollback-' + n
                }
              },
              {
                multi: true
              }
            );
          })
          .then(function(r) {
            n--;
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

    // Deploys attachments to the host specified by the
    // `deployTo` option (see documentation). Only the
    // files that the receiving host does not already
    // have are transmitted. The `aposAttachments` collection
    // on the receiving end is updated. Changes in file visibility are
    // also updated.
    //
    // If a file the receiving end does not have yet is inaccessible
    // (trash) on the sending end, the actual file is not sent at this time,
    // since it would not be visible anyway and sending it would require
    // toggling the permissions. We do send those paths if it becomes
    // visible later.
    //
    // If the module-level `deployTo` option is an array,
    // then `options.deployTo` must be one of those objects.

    self.deployAttachments = function(options) {
      options = options || {};
      var deployTo = self.resolveDeployTo(options);
      var remote, local;
      var inserts = [];
      var newlyVisibles = [];
      var newCrops = [];
      var paths = [];
      return self.remoteApi('attachments', { json: true }, options)
      .then(function(_remote) {
        remote = _remote;
        return self.apos.attachments.db.find({}).toArray();
      })
      .then(function(_local) {
        local = _local;
        var remoteById = _.keyBy(remote, '_id');
        var localById = _.keyBy(local, '_id');
        _.each(local, function(attachment) {
          var remote = remoteById[attachment._id];
          if (!remote) {
            inserts.push(attachment);
          } else if (remote.trash && (!local.trash)) {
            newlyVisibles.push(attachment._id);
          } else {
            _.each(attachment.crops, function(crop) {
              if (!_.find(remote.crops || [], function(remoteCrop) {
                return _.isEqual(crop, remoteCrop);
              })) {
                appendPaths(attachment, crop);
                newCrops.push({ _id: attachment._id, crop: crop });
              }
            });
          }
        });
      })
      .then(function() {
        _.each(inserts.concat(newlyVisibles), function(attachment) {
          appendPaths(attachment, null);
          _.map(attachment.crops, function(crop) {
            appendPaths(attachment, crop);
          });
        });
      })
      .then(function() {
        return Promise.map(paths, function(path) {
          return self.deployPath(path, options)
        }, { concurrency: self.options.sendAttachmentConcurrency });
      })
      .then(function() {
        return self.remoteApi('attachments', {
          method: 'POST',
          json: true,
          body: {
            inserts: inserts,
            newCrops: newCrops,
            newlyVisibles: _.map(newlyVisibles, '_id')
          }
        }, options);
      });

      function appendPaths(attachment, crop) {
        if (attachment.trash) {
          // Don't send what we would have to temporarily chmod first
          // and the end user will not be able to see anyway
          return;
        }
        _.each(self.apos.attachments.imageSizes.concat([ { name: 'original' } ]), function(size) {
          paths.push(
            self.apos.attachments.url(attachment, { uploadfsPath: true, size: size.name, crop: crop })
          );
        });
      }

    };

    // Deploy the file at one uploadfs path to the remote server.
    // If the module-level `deployTo` option is an array, then
    // `options.deployTo` must be present and it must be one
    // of those objects.

    self.deployPath = function(path, options) {
      var copyOut = Promise.promisify(self.apos.attachments.uploadfs.copyOut);
      var id = cuid();
      var temp = self.apos.rootDir + '/data/attachment-temp-' + id;
      return copyOut(path, temp)
      .then(function() {
        return self.remoteApi('attachments/upload', {
          method: 'POST',
          formData: {
            path: path,
            file: fs.createReadStream(temp)
          }
        }, options);
      })
      .finally(function() {
        if (fs.existsSync(temp)) {
          fs.unlinkSync(temp);
        }
      });
    };

    // Invoke a remote API. A simple wrapper around request-promise
    // build the correct URL. `requestOptions` is the usual `request` options object.
    // `options` may contain `deployTo`; when the `deployTo` option for the
    // module is an array, `options.deployTo` must be one of those objects.
    //
    // Returns a promise.

    self.remoteApi = function(verb, requestOptions, options) {
      var deployTo = self.resolveDeployTo(options);
      if (!deployTo.apikey) {
        return Promise.reject(new Error('deployTo.apikey option must be configured'));
      }
      requestOptions = _.merge({
        headers: {
          'Authorization': 'Bearer ' + deployTo.apikey
        }
      }, requestOptions);
      var url = deployTo.baseUrl + deployTo.prefix + '/modules/apostrophe-review-and-deploy/' + verb;
      return request(deployTo.baseUrl + deployTo.prefix + '/modules/apostrophe-review-and-deploy/' + verb, requestOptions);
    };

    // If a `deployTo` object was passed to this method, return that,
    // otherwise the sole configured `deployTo` object. For bc;
    // newer code always passes an option.
    
    self.resolveDeployTo = function(options) {
      return options.deployTo || self.deployTo[0];
    };

    // Fetch an array of `deployTo` objects suitable to receive
    // a deployment for the current locale.

    self.getDeployToArrayForCurrentLocale = function(req) {
      var locale = workflow.liveify(req.locale || self.defaultLocale);
      return _.filter(self.deployTo, function(deployTo) {
        if (!deployTo.locales) {
          return true;
        }
        if (_.includes(deployTo.locales, locale)) {
          return true;
        }
        return false;
      });
    };

    self.deployPermissions = function(req, res, next) {
      return expressBearerToken(req, res, function() {
        if ((!req.token) || (!self.options.receiveFrom) || (!self.options.receiveFrom.apikey) || (self.options.receiveFrom.apikey !== req.token)) {
          return res.status(401).send('unauthorized');
        }
        return next();
      });
    };

    self.ensureIndexes = function(callback) {
      return self.apos.docs.db.ensureIndex({ siteReviewRank: 1 }, callback);
    };

    self.composeDeployTo = function() {
      if (Array.isArray(self.options.deployTo)) {
        self.deployTo = self.options.deployTo;
      } else if (self.options.deployTo) {
        self.deployTo = [ self.options.deployTo ];
      }
    };

  }
};
