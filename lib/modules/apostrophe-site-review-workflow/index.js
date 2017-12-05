module.exports = {
  improve: 'apostrophe-workflow',
  construct: function(self, options) {
    var superCommit = self.commit;
    self.commit = function(req, from, to, callback) {
      var siteReview = self.apos.modules['apostrophe-site-review'];
      return siteReview.getActiveReview(req)
      .then(function(review) {
        if (review) {
          return callback('under-review');
        }
        return superCommit(req, from, to, callback);
      })
      .catch(function(err) {
        return callback(err);
      });
    };
  }
};
