apos.define('apostrophe-review-and-deploy-manager-modal', {
  extend: 'apostrophe-pieces-manager-modal',
  construct: function(self, options) {
    var superBeforeShow = self.beforeShow;
    self.beforeShow = function(callback) {
      self.$el.on('click', '[data-apos-deploy]', function() {
        // Ah, "confirm:" the screen door on the side of our space shuttle
        if (confirm('This will make the approved content of this locale live on one or more servers. Are you sure?')) {
          // There is never more than one active review per locale so we don't need
          // to specify any parameters to identify it
          self.api('deploy', {}, function(data) {
            apos.modules['apostrophe-jobs'].progress(data.jobId, { change: self.options.name });
          }, function(err) {
            apos.notify('An error occurred initiating the deployment.', { type: 'error' });
          });
        }
        return false;
      });
      self.$el.on('click', '[data-apos-rollback]', function() {
        if (confirm('This will undo the most recent successful deployment of this locale. Are you sure?')) {
          self.api('rollback', {}, function(data) {
            apos.modules['apostrophe-jobs'].progress(data.jobId, { change: self.options.name });
          }, function(err) {
            apos.notify('An error occurred initiating the rollback.', { type: 'error' });
          });
        }
        return false;
      });
      return superBeforeShow(callback);
    };
  }
});
