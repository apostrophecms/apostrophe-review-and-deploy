apos.define('apostrophe-site-review', {
  extend: 'apostrophe-pieces',
  afterConstruct: function(self) {
    self.enableClickHandlers();
    self.enableReviewingClass();
  },
  construct: function(self, options) {
    var workflow = apos.modules['apostrophe-workflow'];
    self.enableClickHandlers = function() {
      apos.ui.link('apos-site-review', 'approve', function() {
        apos.ui.globalBusy(true);
        self.api('approve', {
          ids: workflow.getDocIds()
        }, function(data) {
          if (data.status === 'ok') {
            self.next();
          } else if (data.status === 'Ready to Deploy') {
            apos.ui.globalBusy(false);
            apos.notify('The review is complete.', { status: 'success' });
            $('[data-apos-site-review-menu]').hide();
          } else {
            apos.ui.globalBusy(false);
            apos.notify('An error occurred during the review process.', { status: 'error' });
          }
        });
      });
      apos.ui.link('apos-site-review', 'reject', function() {
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
      apos.ui.link('apos-site-review', 'next', function() {
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
        $('body').addClass('apos-site-review-reviewing');
      }
    };
  }
});
