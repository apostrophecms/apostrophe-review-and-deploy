apos.define('apostrophe-site-review-manager-modal', {
  extend: 'apostrophe-pieces-manager-modal',
  construct: function(self, options) {
    var superBeforeShow = self.beforeShow;
    self.beforeShow = function(callback) {
      self.$el.on('click', '[data-apos-deploy]', function() {
        var _id = $(this).closest('[data-piece]').attr('data-piece');
        // Ah, "confirm:" the screen door on the side of our space shuttle
        if (confirm('This will make the approved content of this locale live in production. Are you sure?')) {
          alert('Well, good, but we have to implement it first. ' + _id);
        }
        return false;
      });
      return superBeforeShow(callback);
    };
  }
});
