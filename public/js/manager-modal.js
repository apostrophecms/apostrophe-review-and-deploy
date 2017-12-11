apos.define('apostrophe-review-and-deploy-manager-modal', {
  extend: 'apostrophe-pieces-manager-modal',
  construct: function(self, options) {
    var superBeforeShow = self.beforeShow;
    self.beforeShow = function(callback) {
      self.$el.on('click', '[data-apos-deploy]', function() {
        var _id = $(this).closest('[data-piece]').attr('data-piece');
        // Ah, "confirm:" the screen door on the side of our space shuttle
        if (confirm('This will make the approved content of this locale live in production. Are you sure?')) {
          self.api('deploy', {}, function(data) {
            apos.modules['apostrophe-jobs'].progress(data.jobId, { change: self.options.name });
          }, function(err) {
            apos.notify('An error occurred initiating the deployment.', { type: 'error' });
          });
        }
        return false;
      });
      return superBeforeShow(callback);
    };
  }
});
