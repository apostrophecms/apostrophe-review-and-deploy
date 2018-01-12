apos.define('apostrophe-review-and-deploy', {
  extend: 'apostrophe-pieces',
  afterConstruct: function(self) {
    self.enableClickHandlers();
    self.enableReviewingClass();
    self.enableModified();
  },
  construct: function(self, options) {
    
    var workflow = apos.modules['apostrophe-workflow'];

    self.enableModified = function() {
      self.api('modified', {
        ids: _.uniq(workflow.getDocIds().concat([ self.options.contextId ]))
      }, function(data) {
        if (data.status === 'ok') {
          if (data.modified) {
            $('[data-apos-review-modified]').addClass('apos-review-modified--active');
          }
        }
      });
    };

    self.enableClickHandlers = function() {
      apos.ui.link('apos-review', 'approve', function() {
        apos.ui.globalBusy(true);
        self.api('approve', {
          ids: _.uniq(workflow.getDocIds().concat([ self.options.contextId ]))
        }, function(data) {
          if (data.status === 'ok') {
            self.next();
          } else if (data.status === 'Ready to Deploy') {
            apos.ui.globalBusy(false);
            apos.notify('The review is complete.', { status: 'success' });
            $('[data-apos-review-menu]').hide();
          } else {
            apos.ui.globalBusy(false);
            apos.notify('An error occurred during the review process.', { status: 'error' });
          }
        });
      });
      apos.ui.link('apos-review', 'reject', function() {
        apos.ui.globalBusy(true);
        self.api('reject', {
          _id: self.options.contextId
        }, function(data) {
          if (data.status === 'ok') {
            window.location.reload(true);
          } else {
            apos.notify('An error occurred while attempting to reject the document.', { type: 'error' });
          }
        });
      });
      apos.ui.link('apos-review', 'next', function() {
        apos.ui.globalBusy(true);
        self.next();
      });
    },
    // Navigate to next doc requiring review, if any
    self.next = function() {
      return self.api('next', {}, function(data) {
        if (data.status === 'ok') {
          if (window.location.href === data.next._url) {
            window.location.reload(true);
          } else {
            window.location.href = data.next._url;
          }
        }
      });
    };

    self.enableReviewingClass = function() {
      if (self.options.reviewing) {
        // Under review
        $('body').addClass('apos-review-reviewing');
      }
    };
  }
});
