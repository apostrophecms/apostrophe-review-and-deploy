apos.define('apostrophe-site-review', {
  construct: function(self, options) {
    self.enableClickHandlers = {
      apos.ui.link('apos-site-review-approve', function() {
        apos.ui.globalBusy(true);
        self.api('approve', {
          workflowGuid: apos.modules['apostrophe-workflow'].options.contextGuid
        }, function(data) {
          if (data.status === 'ok') {
            self.next();
          }
        }
        return false;
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
  }
});
