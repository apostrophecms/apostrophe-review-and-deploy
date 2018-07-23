apos.define('apostrophe-review-and-deploy-editor-modal', {
  extend: 'apostrophe-pieces-editor-modal',
  construct: function(self, options) {
    // When a review is put into the "In Progress" status,
    // go to the first URL that needs to be reviewed
    var superDisplayResponse = self.displayResponse;
    self.beforePopulate = function(piece, callback) {
      var workflow = apos.modules['apostrophe-workflow'];
      // This is enforced server-side, here it is just for aesthetics
      piece.locale = workflow.locale.replace(/\-draft$/, '');
      return setImmediate(callback);
    };
    self.displayResponse = function(result, callback) {
      if (result.data.status === 'In Progress') {
        self.api('apostrophe-workflow:workflow-mode', { workflowGuid: apos.modules['apostrophe-workflow'].options.contextGuid, mode: 'live' }, function(result) {
          self.manager.next();
        });
      } else {
        return superDisplayResponse(result, callback);
      }
    }
  }
});
