module.exports = {
  improve: 'apostrophe-global',
  construct: function(self, options) {
    // Exempt our own API routes from the whileBusy lock
    const superCheckWhileBusy = self.checkWhileBusy;
    self.checkWhileBusy = function(req, _global, callback) {
      var review = self.apos.modules['apostrophe-review-and-deploy'];
      var route = review.action + '/job/progress';
      if (req.url.substr(0, route.length + 1) === route + '/') {
        return callback(null);
      }
      return superCheckWhileBusy(req, _global, callback);
    };
  }
};
