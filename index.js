var _ = require('lodash');
var async = require('async');

module.exports = {
  extend: 'apostrophe-pieces',
  name: 'apostrophe-review',
  label: 'Review',
  adminOnly: true,

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
        label: 'Status'
      }
    ].concat(options.addColumns || []);
    options.removeColumns = [ 'published' ].concat(options.removeColumns || []);
    options.removeFilters = [ 'published' ].concat(options.removeFilters || []);
  },
  
  afterConstruct: function(self) {
    self.excludeFromWorkflow();
    self.addRoutes();
    self.apos.pages.addAfterContextMenu(self.menu);
  },

  construct: function(self, options) {
    var workflow = options.apos.modules['apostrophe-workflow'];
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
      try {
        // pieces have a default pageBeforeSend,
        // which still needs to be invoked
        superPageBeforeSend(req);
      } catch (e) {
        return callback(e);
      }
      if (!req.user) {
        return next();
      }
      return self.getActiveReview(req)
      .then(function(review) {
        req.data.siteReview = req.data.siteReview || {};
        req.data.siteReview.review = review;
        if (req.data.piece) {
          req.data.siteReview.unreviewed = (req.data.piece.siteReviewApproved === null);
        } else if (req.data.page) {
          req.data.siteReview.unreviewed = (req.data.page.siteReviewApproved === null);
        }
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
        // need to check the permissions properly on the doc
        return self.apos.docs.db.update({
          workflowGuid: self.apos.launder.id(req.body.workflowGuid),
          workflowLocale: self.liveify(req.locale),
        }, {
          $set: {
            siteReviewApproved: true
          }
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
            return res.send({ status: 'ended' });
          } else {
            return res.send({ status: 'ok', next: _.pick(next, 'title', '_id', '_url') });
          }
        })
        .catch(function(err) {
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
          review.rejectedWorkflowGuid = self.apos.launder.id(req.body.workflowGuid);
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

    self.getNextDoc = function(req) {
      return self.apos.docs.find(req, { siteReviewRank: { $exists: 1 }, siteReviewApproved: null }).sort({ siteReviewRank: 1 }).joins(false).areas(false).log(true).toObject()
      .then(function(doc) {
        if (!doc) {
          return null;
        }
        if (!doc._url) {
          // TODO implement
          doc._url = self.action + '/review-orphan-type?_id=' + doc._id;
        }
        return doc;
      });
    };

    self.getActiveReview = function(req) {
      return self.find(req, { status: 'In Progress' }).toObject();
    };

    // If a new review is created for a given locale, any review previously in
    // progress is considered to have failed. TODO: warn in this situation.

    self.beforeInsert = function(req, piece, options, callback) {
      piece.locale = workflow.liveify(req.locale);
      return self.apos.docs.db.update({
        type: self.name,
        locale: req.locale,
        status: 'In Progress'
      }, {
        $set: {
          status: 'Failed'
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
  
  }
};
