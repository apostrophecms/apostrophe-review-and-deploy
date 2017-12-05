var assert = require('assert');

describe('apostrophe-site-review', function() {

  var apos;

  this.timeout(5000);

  after(function() {
    apos.db.dropDatabase();
  });

  //////
  // EXISTENCE
  //////

  it('should be a property of the apos object', function(done) {
    apos = require('apostrophe')({
      testModule: true,
      
      modules: {
        'apostrophe-pages': {
          park: [],
          types: [
            {
              name: 'home',
              label: 'Home'
            },
            {
              name: 'testPage',
              label: 'Test Page'
            }
          ]
        },
        'apostrophe-workflow': {
          locales: [
            {
              name: 'default',
              children: [
                {
                  name: 'en'
                },
                {
                  name: 'fr'
                }
              ]
            }
          ]
        },
        'apostrophe-site-review': {}
      },
      afterInit: function(callback) {
        assert(apos.modules['apostrophe-site-review']);
        return callback(null);
      },
      afterListen: function(err) {
        done();
      }
    });
  });

  // TODO write test of new export method, create import method,
  // don't forget attachment transport, etc.

  it('should export a locale on request', function() {
    var req = apos.tasks.getReq({ locale: 'fr' });
    return apos.modules['apostrophe-site-review'].export(req)
    .then(function(filename) {
      assert(filename);
      var fs = require('fs');
      assert(fs.existsSync(filename));
      console.log(filename);
    });
  });
});
