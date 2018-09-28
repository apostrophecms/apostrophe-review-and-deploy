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
const backstop = require('backstopjs');
const path = require('path');
const cloudStatic = require('cloud-static');

module.exports = {
  extend: 'apostrophe-pieces',
  name: 'apostrophe-review-and-deploy',
  label: 'Review',
  adminOnly: true,
  batchSize: 200,
  rollback: 5,
  sendAttachmentConcurrency: 3,
  moogBundle: {
    modules: [ 'apostrophe-review-and-deploy-workflow', 'apostrophe-review-and-deploy-global' ],
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
    self.enableCloudStatic();
    self.composeDeployTo();
    self.excludeFromWorkflow();
    self.addRoutes();
    self.apos.pages.addAfterContextMenu(self.menu);
    self.apos.pages.addAfterContextMenu(self.visualDiff);
    self.addCsrfExceptions();
    self.modifyVisualDiffFrame();

    return self.ensureIndexes(callback);
  },

  construct: function(self, options) {
    var backstopConfig = path.join(__dirname, 'backstop-config.json');
    backstopConfig = JSON.parse(fs.readFileSync(backstopConfig));

    if (options.backstopConfig && options.backstopConfig.viewports) {
      backstopConfig.viewports = _.concat(backstopConfig.viewports, options.backstopConfig.viewports);
    }

    if (options.backstopConfig && options.backstopConfig.scenarios) {
      _.merge(backstopConfig.scenarios[0], options.backstopConfig.scenarios);
    }

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

    self.generateReport = function(req) {
      var deployToArray = self.getDeployToArrayForCurrentLocale(req);
      var context = req.data.piece || req.data.page;
      return self.getProductionUrl(req, context).then((url) => {
        req.deployFromPath = context._url;
        req.deployToPath = url;
        req.backstopReport = self.apos.rootDir + "/data/backstop_data/html_report/index.html";
        req.backstopReportUrl = self.cs.getUrl('/site-review/report/html_report/index.html');

        var backstopPaths = {
          "bitmaps_reference": self.apos.rootDir + "/data/backstop_data/bitmaps_reference",
          "bitmaps_test": self.apos.rootDir + "/data/backstop_data/bitmaps_test",
          "engine_scripts": self.apos.rootDir + "/data/backstop_data/engine_scripts",
          "html_report": self.apos.rootDir + "/data/backstop_data/html_report",
          "ci_report": self.apos.rootDir + "/data/backstop_data/ci_report"
        };

        backstopConfig.paths = backstopPaths;

        backstopConfig.scenarios[0].url = req.deployToPath;
        backstopConfig.scenarios[0].referenceUrl = req.deployFromPath;
        return backstop('reference', {
          config: backstopConfig
        });
      }).then(() => {
        return backstop('test', { config: backstopConfig }).catch(() => {
          // "Test failed," i.e. the report shows a difference. Not fatal
        });
      }).then(() => {
        // This isn't very unique, but it's impractical to review reports in parallel anyway
        return self.cs.syncFolder(self.apos.rootDir + "/data/backstop_data", "/site-review/report");
      });
    };

    // Applies visual changes on the client-side after the backstop
    // interface loads
    self.modifyVisualDiffFrame = function() {
      self.pushAsset('script', 'visual-diff', {
        when: 'user'
      });
    };

    // Obtains a production URL for the given doc. Returns a
    // promise. doc.workflowLocale must match the current locale.

    self.getProductionUrl = function(req, doc) {
      var deployToArray = self.getDeployToArrayForCurrentLocale(req);
      return self.remoteApi('url', {
        method: 'POST',
        json: true,
        body: {
          workflowLocale: doc.workflowLocale,
          workflowGuid: doc.workflowGuid
        }
      }, {
        deployTo: deployToArray[0]
      })
      .then(function(result) {
        if (result.status === 'ok') {
          return result.url;
        } else {
          throw new Error('url remote api failed');
        }
      });
    };

    self.visualDiff = function(req) {
      if (!self.isAdmin(req)) {
        return '';
      }
      return self.partial('visualDiff',
        {
          workflowMode: req.session.workflowMode,
          deployToPath: req.deployToPath,
          deployFromPath: req.deployFromPath,
          report: req.backstopReportUrl
        }
      );
    };

    var superPageBeforeSend = self.pageBeforeSend;
    self.pageBeforeSend = function(req, callback) {
      var review;
      if (!self.isAdmin(req)) {
        superPageBeforeSend(req);
        return callback(null);
      }

      return self.getActiveReview(req)
      .then(function(_review) {
        review = _review;
        // returns a promise and passes it to the next item in the chain.
        // knows about req because it exists in the enclosure.

        if (review && (req.data.page || req.data.piece)) {
          return self.generateReport(req).catch(function(e) {
            // no backstop report available, probably
            // has not been synced before so the workflowGuid
            // does not correspond, don't panic
          });
        } else {
          return null;
        }
      })
      .then(function() {
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
          if (!deployed) {
            // Treat this as definitely modified, as they
            // have never deployed it before, i.e. the
            // production site is presumed empty and now
            // there's a thing
            return [ true ];
          }
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
        var count;
        return self.getActiveReview(req)
        .then(function(r) {
          review = r;
        })
        .then(function() {
          return self.apos.docs.db.count({
            _id: { $in: ids },
            siteReviewApproved: null
          });
        })
        .then(function(count) {
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
          .then(function() {
            return count;
          });
        })
        .then(function(count) {
          return self.apos.docs.db.update({
            _id: review._id
          }, {
            $inc: {
              reviewed: count
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
          console.error(err);
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

      // Accept information about attachments as `req.body.attachments`.
      // Replies with an object with a `needed` property, containing the
      // ids of the attachments that are new or different (crops). Ignores differences in
      // `docIds` and `trashDocIds` as ids differ between sender and
      // receiver, not all locales exist on both, and the `reflectLocaleSwapInAttachments`
      // method will take care of those later. Updates the attachment
      // objects in the database.
      //
      // The sender will then use the `attachments/upload` route to 
      // deliver all of the relevant uploadfs files, before uploading
      // the actual docs.
      //
      // Can be invoked in several passes to avoid sending massive
      // requests.

      self.route('post', 'attachments', self.deployPermissions, function(req, res) {
        var incoming = req.body.attachments;
        if (!Array.isArray(incoming)) {
          return res.status(400).send('bad request');
        }
        _.each(incoming, function(incoming) {
          if ((!incoming) || (!incoming._id)) {
            return res.status(400).send('bad request');
          }
        });
        var missing, changed;
        return Promise.try(function() {
          return self.apos.attachments.db.findWithProjection({ _id: { $in: _.map(incoming, '_id') }}).toArray().then(function(actual) {
            missing = _.differenceBy(incoming, actual, '_id');
            var found = _.keyBy(missing);
            var common = _.filter(incoming, function(i) {
              return !found[i._id];
            });
            changed = _.differenceBy(common, actual, function(attachment) {
              return JSON.stringify(attachment.crops);
            });
          });
        }).then(function() {
          return Promise.map(missing, function(attachment) {
            // Because these must be recomputed based on the locales we have here, not there
            attachment.docIds = [];
            attachment.trashDocIds = [];
            attachment.trash = false;
            return self.apos.attachments.db.insert(attachment);
          }, { concurrency: 5 })
        }).then(function() {
          return Promise.map(changed, function(attachment) {
            return self.apos.attachments.db.update({
              _id: attachment._id
            }, {
              $set: {
                crops: attachment.crops
              }
            });
          }, { concurrency: 5 })
        }).then(function() {
          return res.send({
            missing: _.map(missing, '_id'),
            changed: _.map(changed, '_id')
          });
        });
      });
        
      // Accept a single file at a specified uploadfs path and address its enabled/disabled status
      // based on the trash flag in the attachments collection locally
      self.route('post', 'attachments/upload', self.apos.middleware.files, self.deployPermissions, function(req, res) {
        var copyIn = Promise.promisify(self.apos.attachments.uploadfs.copyIn);
        var disable = Promise.promisify(self.apos.attachments.uploadfs.disable);
        var metadata;
        var file;
        let path = null;
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
          console.error(e);
          console.error('error in attachments/upload');
          return res.status(400).send('bad request');
        }
        return Promise.try(function() {
          var _id = self.apos.launder.id(req.body._id);
          if (!_id) {
            throw new Error('no id');
          }
          return self.apos.attachments.db.findOne({ _id: req.body._id });
        }).then(function(attachment) {
          if (!attachment) {
            throw new Error('not found');
          }
          return attachment;
        }).then(function(attachment) {
          return copyIn(file.path, path).then(function() {
            if (attachment.trash) {
              return disable(path);
            }
          });
        }).then(function() {
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
              return self.deployAttachments(locale, options);
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
              return self.monitorJobUntilDone(result.jobId, _.assign({ error: 'upload of locale failed' }, options));
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

      // Monitors a remote job until it is done

      self.monitorJobUntilDone = function(jobId, options) {
        return self.remoteApi('job/progress', {
          method: 'POST',
          json: true,
          body: {
            jobId: jobId
          }
        }, options)
        .then(function(job) {
          if (job.status === 'completed') {
            return;
          } else if (job.status === 'failed') {
            throw new Error(options.error || 'An error occurred');
          } else {
            return Promise.delay(250).then(function() {
              return self.monitorJobUntilDone(jobId, options);
            });
          }
        });
      };

      // UI route to initiate a rollback. Replies with `{ jobId: nnn }`,
      // suitable for calling `apos.modules['apostrophe-jobs'].progress(jobId)`.

      self.route('post', 'rollback', self.requireAdmin, function(req, res) {

        var locale = workflow.liveify(req.locale);

        var deployToArray = self.getDeployToArrayForCurrentLocale(req);

        return self.apos.modules['apostrophe-jobs'].runNonBatch(req, run, {
          label: 'Rolling Back'
        });

        function run(req, reporting) {
          reporting.setTotal(deployToArray.length);
          return Promise.map(deployToArray, function(deployTo) {
            var filename;
            var options = {
              deployTo: deployTo
            };
            return Promise.try(function() {
              return self.remoteApi('rollback-api', {
                method: 'POST',
                json: true,
                body: {
                  locale: locale
                }
              }, options);
            }).then(function(result) {
              return self.monitorJobUntilDone(result.jobId, _.assign({ error: 'rollback of locale failed' }, options));
            }).then(function() {
              reporting.good();
            });
          }).catch(function(err) {
            reporting.bad();
            throw err;
          });
        }
      });

      // api route to actually carry out a rollback on this specific server.
      // Like the locale route, it responds with job information that can be
      // used to poll the `job/progress` route.

      self.route('post', 'rollback-api', self.deployPermissions, function(req, res) {
        var locale = self.apos.launder.string(req.body.locale);
        if (!locale) {
          console.error("bad input in rollback route");
          return res.status(400).send('bad request');
        }
        return self.apos.modules['apostrophe-jobs'].runNonBatch(req, run, {
          label: 'Rolling Back'
        });
        function run(req, reporting) {
          return self.rollbackLocale(locale);
        }
      });

      // Backend API to actually deploy a locale file to a
      // specific target server. Replies with job information
      // suitable for polling the `job/progress` route.

      self.route('post', 'locale', self.deployPermissions, self.apos.middleware.files, function(req, res) {
        var locale = self.apos.launder.string(req.body.locale);
        var file = req.files && req.files.file;
        if (!(locale && file)) {
          console.error("bad input in locale route");
          return res.status(400).send('bad request');
        }
        return self.apos.modules['apostrophe-jobs'].runNonBatch(req, run, {
          label: 'Receiving'
        });
        function run(req, reporting) {
          return self.importLocale(locale, file.path);
        }
      });

      // The regular job-monitoring route is CSRF protected and
      // it renders markup we don't care about when we're monitoring
      // a long-running job from within a larger job. Provide our own
      // access to the job object. TODO: think about whether
      // this should be a standard route of `apostrophe-jobs`.
      self.route('post', 'job/progress', self.deployPermissions, function(req, res) {
        var jobId = self.apos.launder.string(req.body.jobId);
        if (!jobId) {
          console.error('missing jobId');
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

      self.route('post', 'url', self.deployPermissions, function(req, res) {
        req.locale = self.apos.launder.string(req.body.workflowLocale);
        var workflowGuid = self.apos.launder.id(req.body.workflowGuid);

        return self.apos.docs.find(req, {
          workflowLocale: req.locale,
          workflowGuid: workflowGuid
        }).permission(false).toObject(function(err, doc) {
          if (err) {
            self.apos.utils.error(err);
            return res.send({
              status: 'error'
            });
          } else if (!doc) {
            return res.send({
              status: 'notfound'
            });
          } else {
            return res.send({
              status: 'ok',
              url: doc._url
            });
          }
        });
      });
    };

    self.addCsrfExceptions = function() {
      self.apos.on('csrfExceptions', function(list) {
        list.push(self.action + '/locale');
        list.push(self.action + '/url');
        list.push(self.action + '/job/progress');
        list.push(self.action + '/deploy');
        list.push(self.action + '/attachments');
        list.push(self.action + '/attachments/upload');
        list.push(self.action + '/rollback-api');
      });
    };

    // Returns a promise for the next doc ready for review.
    self.getNextDoc = function(req) {
      options = options || {};
      var cursor = self.apos.docs.find(req, { siteReviewRank: { $exists: 1 }, siteReviewApproved: null }).sort({ siteReviewRank: 1 }).joins(false).areas(false);
      return self.getActiveReview(req).then(function(review) {
        // Grab 50 at a time because some of them will be orphaned pieces
        // without a `_url`, and we need to preemptively and efficiently
        // mark those as reviewed in order to reach the next
        // doc that does have a `_url`
        return cursor.limit(50).toArray().then(function(docs) {
          var orphans;
          if (!docs.length) {
            return null;
          }
          orphans = _.filter(docs, function(doc) {
            return !doc._url;
          });
          if (orphans.length < docs.length) {
            // A doc with a _url is present, deliver it
            return _.find(docs, function(doc) {
              return doc._url;
            });
          }
          // Mark some orphans as reviewed
          return self.apos.docs.db.update({
            _id: { $in: _.map(orphans, '_id') }
          }, {
            $set: {
              siteReviewApproved: true
            }
          }, {
            multi: true
          }).then(function() {
            // Count the orphans as reviewed
            return self.apos.docs.db.update({
              _id: review._id
            }, {
              $inc: {
                reviewed: orphans.length
              }
            });
          })
          .then(function() {
            return self.getNextDoc(req);
          });
        });
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
      return self.apos.docs.db.findWithProjection({ workflowLocale: piece.locale, trash: { $ne: true }, published: { $ne: false } }, { type: 1 }).toArray(function(err, docs) {
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
      return self.apos.docs.db.findWithProjection({ workflowLocale: locale }, { _id: 1 }).toArray()
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
        return self.apos.docs.db.findWithProjection({
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

    self.importLocale = function(locale, filename) {
      var locale = workflow.liveify(locale);
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
      }).then(function() {
        // Update attachment visibility based on what's gone and what's in the
        // new import
        return self.reflectLocaleSwapInAttachments(locale, locale + '-importing');
      }).then(function() {
        // Rename locale-rollback-0 to locale-rollback-1, etc.
        var n = self.options.rollback || 0;
        return archiveNext();
        function archiveNext() {
          if (n === 0) {
            return;
          }
          return Promise.try(function() {
            if (n === self.options.rollback) {
              // If the max is 5 and rollback-5 already exists,
              // we'll be dropping 4 on top of an existing 5,
              // leading to collisions in the index. Remove
              // the old 5 first
              return self.removeLocale(locale + '-rollback-' + n);
            }
          }).then(function() {
            return self.renameLocale(locale + '-rollback-' + (n - 1), locale + '-rollback-' + n);
          }).then(function(r) {
            n--;
            return archiveNext();
          });
        }
      }).then(function() {
        // Purge stuff we no longer keep for rollback.
        //
        // In theory `rollback` could have been a really big number once
        // and set smaller later. In practice set a reasonable bound
        // so this is a single, fast call.
        var locales = _.map(_.range(self.options.rollback || 0, 100), function(i) {
          return locale + '-rollback-' + i
        });
        return self.apos.docs.db.remove({
          workflowLocale: { $in: locales }
        });
      }).then(function() {
        var req = self.apos.tasks.getReq({ locale: locale });
        // Showtime: grab a global lock on the locale in question.
        // While we have that lock, do the things that aren't atomic
        // as quickly as we can
        return self.apos.global.whileBusy(function() {
          return Promise.try(function() {
            // Showtime, part 2: 
            //
            // If we're keeping old deployments for rollback,
            // rename the currently live locale to localename-rollback-0,
            // otherwise discard it
            if (self.options.rollback) {
              return self.renameLocale(locale, locale + '-rollback-0');
            } else {
              return self.removeLocale(locale);
            }
          }).then(function() {
            // Showtime, part 3:
            //
            // rename the temporary locale to be the live locale.
            // Do workflowLocaleForPathIndex first to minimize
            // possible inconsistent time
            return self.renameLocale(locale + '-importing', locale);
          });
        }, { locale: locale });
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

    self.rollbackLocale = function(locale) {
      return Promise.try(function() {
        return self.apos.docs.db.findOne({ workflowLocale: locale + '-rollback-0' }).then(function(canary) {
          if (!canary) {
            throw new Error('notfound');
          }
        });
      }).then(function() {
        return self.renameLocale(locale, locale + '-rolling-back');
      }).then(function() {
        // Update attachment visibility before we make the content visible
        return self.reflectLocaleSwapInAttachments(locale + '-rolling-back', locale + '-rollback-0');
      }).then(function() {
        // Showtime (content becomes visible)
        return self.renameLocale(locale + '-rollback-0', locale);
      }).then(function() {
        return Promise.mapSeries(_.range(0, self.options.rollback - 1), function(i) {
          return self.renameLocale(locale + '-rollback-' + (i + 1), locale + '-rollback-' + i);
        });
      }).then(function() {
        return self.removeLocale(locale + '-rolling-back');
      });
    };

    // Renames a locale in the database. Called by
    // rollbackLocale.
    self.renameLocale = function(oldName, newName) {
      return self.apos.docs.db.update({
        workflowLocale: oldName
      },
      {
        $set: {
          workflowLocale: newName
        }
      }, {
        multi: true
      })
      .then(function() {
        // workflowLocaleForPathIndex is a separate property, not always present,
        // so we are stuck with a second call
        return self.apos.docs.db.update({
          workflowLocaleForPathIndex: oldName
        },
        {
          $set: {
            workflowLocaleForPathIndex: newName
          }
        }, {
          multi: true
        })
      });
    };


    // Remove a locale from the database. Used by rollbackLocale and similar methods.
    // Take care, there is no undo. Returns a promise.

    self.removeLocale = function(locale) {
      return self.apos.docs.db.remove({
        workflowLocale: locale
      });
    };

    // Deploys attachments for the given locale to the host specified by the
    // `deployTo` option (see documentation).
    //
    // If the module-level `deployTo` option is an array,
    // then `options.deployTo` must be one of those objects.
    //
    // This method:
    //
    // * Sends information about all attachments relevant to the locale
    // * Receives information about attachments that are `missing`
    // * Receives information about attachments that are `changed`
    // * Sends all uploadfs files relevant to either, for simplicity.
    //
    // The receiving end does not fully update uploadfs enable/disable
    // status until after the locale's actual docs are deployed, making
    // that computation possible.

    self.deployAttachments = function(locale, options) {
      options = options || {};

      // To avoid RAM and network issues, we'll fetch this many docs at a time
      // and build up an array of attachments to be sent, and we'll also use this
      // threshold to decide we have enough attachments to send (but of course
      // we flush one last batch at the end)
      var batchSize = 100;
      var lastId = '';
      var seen = {};
      var attachments = [];

      return nextBatch().then(function() {
        if (attachments.length) {
          return sendBatch();
        }
      });

      function nextBatch() {
        var last = false;
        return Promise.try(function() {
          return self.apos.docs.db.findWithProjection({ workflowLocale: locale, _id: { $gt: lastId } }).sort({ _id: 1 }).limit(batchSize).toArray();
        }).then(function(batch) {
          if (!batch.length) {
            last = true;
            return;
          }
          lastId = _.last(batch)._id;
          attachments = attachments.concat(_.flatten(_.map(batch, self.apos.attachments.all)));
          attachments = _.filter(attachments, function(attachment) {
            return !seen[attachment._id];
          });
          _.each(attachments, function(attachment) {
            seen[attachment._id] = true;
          });
          if (attachments.length >= batchSize) {
            return sendBatch();
          }
        }).then(function() {
          if (!last) {
            return nextBatch();
          }
        });
      }

      function sendBatch() {
        var actual;
        return Promise.try(function() {
          return self.apos.attachments.db.findWithProjection({ _id: { $in: _.map(attachments, '_id') } }).toArray();
        }).then(function(_actual) {
          actual = _actual;
          // We got the full attachment objects from the db, now forget the batch
          // so a new batch can be started
          attachments = [];
          // Pass the actual attachment info to the receiver
          return self.remoteApi('attachments', {
            method: 'POST',
            json: true,
            body: {
             attachments: actual
            }
          }, options);
        }).then(function(info) {
          // Learn what ids are missing and changed; treat them all the same,
          // just supply the missing files
          var needed = info.missing.concat(info.changed);
          return _.filter(actual, function(attachment) {
            return _.find(needed, function(n) {
              return n === attachment._id;
            });
          });
        }).then(function(needed) {
          var paths = [];
          _.each(needed, function(attachment) {
            appendPaths(attachment, null);
            _.map(attachment.crops || [], function(crop) {
              appendPaths(attachment, crop);
            });
          });
          return Promise.map(paths, function(path) {
            return self.deployPath(path.attachment, path.path, options)
          }, { concurrency: self.options.sendAttachmentConcurrency });
          function appendPaths(attachment, crop) {
            if (attachment.trash) {
              // Don't send what we would have to temporarily chmod first
              // and the end user will not be able to see anyway
              return;
            }
            _.each(self.apos.attachments.imageSizes.concat([ { name: 'original' } ]), function(size) {
              if ((size !== 'original') && (attachment.group !== 'images')) {
                return;
              }
              paths.push(
                {
                  path: self.apos.attachments.url(attachment, { uploadfsPath: true, size: size.name, crop: crop }),
                  attachment: attachment
                }
              );
            });
          }
        });
      }
    };

    // Deploy the file at one uploadfs path to the remote server.
    // If the module-level `deployTo` option is an array, then
    // `options.deployTo` must be present and it must be one
    // of those objects. If access to the file is disabled it will
    // be briefly enabled to permit the copyOut operation to succeed.

    self.deployPath = function(attachment, path, options) {
      var copyOut = Promise.promisify(self.apos.attachments.uploadfs.copyOut);
      var disable = Promise.promisify(self.apos.attachments.uploadfs.disable);
      var enable = Promise.promisify(self.apos.attachments.uploadfs.enable);
      var id = cuid();
      var enabled = false;
      var temp = self.apos.rootDir + '/data/attachment-temp-' + id;
      return Promise.try(function() {
        if (attachment.trash) {
          // Temporarily enable access so we can copy it out
          return enable(path).then(function() {
            enabled = true;
          });
        }
      }).then(function() {
        return copyOut(path, temp);
      }).then(function() {
        return self.remoteApi('attachments/upload', {
          method: 'POST',
          formData: {
            path: path,
            _id: attachment._id,
            file: fs.createReadStream(temp)
          }
        }, options);
      }).finally(function() {
        if (fs.existsSync(temp)) {
          fs.unlinkSync(temp);
        }
        if (enabled) {
          // Re-disable access
          return disable(path);
        }
      });
    };

    // Given an old locale that is being archived for rollback
    // or removed due to rollback, and a new locale that is
    // coming into play, update the docIds and trashDocIds
    // properties of all attachments mentioned in either
    // then update the availability of attachments accordingly.
    // Returns a promise.

    self.reflectLocaleSwapInAttachments = function(oldLocale, newLocale) {
      return Promise.try(function() {
        return swapOut();
      }).then(function() {
        return swapIn();
      }).then(function() {
        return Promise.promisify(self.apos.attachments.updatePermissions)();
      });
      function swapOut() {
        var lastId = '';
        return nextBatch();
        function nextBatch() {
          return self.apos.docs.db.findWithProjection({ workflowLocale: oldLocale, _id: { $gt: lastId } }, { _id: 1 }).sort({ _id: 1 }).limit(1000).toArray().then(function(docs) {
            if (!docs.length) {
              return;            
            }
            var ids = _.map(docs, '_id');
            return Promise.try(function() {
              if (!ids.length) {
                return;
              }
              return self.apos.attachments.db.update({
              },
              {
                $pullAll: {
                  docIds: ids,
                  trashDocIds: ids
                }
              }, {
                multi: true
              });  
            }).then(function() {
              lastId = _.last(ids);
              return nextBatch();
            });
          });
        }
      }
      function swapIn() {
        var lastId = '';
        var last = false;
        return nextBatch();
        function nextBatch() {
          return Promise.try(function() {
            return self.apos.docs.db.findWithProjection({ workflowLocale: newLocale, _id: { $gt: lastId } }).sort({ _id: 1 }).limit(100).toArray().then(function(docs) {
              var attachmentUpdates = [];
              _.each(docs, function(doc) {
                _.each(self.apos.attachments.all(doc), function(attachment) {
                  attachmentUpdates.push({
                    _id: attachment._id,
                    docId: doc._id,
                    docTrash: doc.trash
                  });
                });
              });
              if (!docs.length) {
                last = true;
              } else {
                lastId = _.last(docs)._id;
              }
              return attachmentUpdates;
            });
          }).then(function(attachmentUpdates) {
            return Promise.map(attachmentUpdates, function(au) {
              if (au.docTrash) {
                return self.apos.attachments.db.update({
                  _id: au._id
                }, {
                  $addToSet: {
                    trashDocIds: au.docId
                  }
                });
              } else {
                return self.apos.attachments.db.update({
                  _id: au._id
                }, {
                  $addToSet: {
                    docIds: au.docId
                  }
                });
              }
            }, { concurrency: 5 });
          }).then(function() {
            if (!last) {
              return nextBatch();
            }
          });
        }
      }
    };

    // Invoke a remote API. A simple wrapper around request-promise.
    // `requestOptions` is the usual `request` options object.
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
      var url = deployTo.baseUrl + (deployTo.prefix || '') + '/modules/apostrophe-review-and-deploy/' + verb;
      return request(url, requestOptions);
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

    self.enableCloudStatic = function(callback) {
      self.cs = cloudStatic();
      return self.cs.init({
        db: self.apos.db,
        uploadfs: self.apos.attachments.uploadfs
      }, callback);
    };

    var superGetManagerControls = self.getManagerControls;
    self.getManagerControls = function(req) {
      var controls = superGetManagerControls(req);
      var index = _.findIndex(controls, { action: 'cancel' });
      controls.splice((index !== undefined) ? (index + 1) : 0, 0, {
        type: 'minor',
        label: 'Roll Back',
        action: 'rollback'
      });
      return controls;
    };

  }
};
