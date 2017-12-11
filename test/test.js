var assert = require('assert');
var fs = require('fs');

describe('apostrophe-site-review', function() {

  var apos;
  var apos2;
  var exported;
  var oldAboutId;
  var attachment;    
  
  this.timeout(5000);

  after(function() {
    if (apos) {
      apos.db.dropDatabase();
    }
    if (apos2) {
      apos2.db.dropDatabase();
    }
  });

  //////
  // EXISTENCE
  //////

  it('should be a property of the apos object', function(done) {
    apos = require('apostrophe')({
      testModule: true,
      
      modules: {
        'apostrophe-pages': {
          park: [
            {
              slug: '/test',
              type: 'testPage',
              navigation: {
                type: 'area',
                items: [
                  {
                    type: 'navigation',
                    _id: 'xyz',
                    by: 'id',
                    ids: [ 'placeholder' ]
                  }
                ]
              }
            },
            {
              slug: '/about',
              type: 'testPage',
              title: 'About'
            }
          ],
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
        'apostrophe-site-review': {
          deployTo: {
            baseUrl: 'http://localhost:7001',
            prefix: '',
            apikey: 'testtest'
          }
        }
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

  it('should export a locale on request', function() {
    var req = apos.tasks.getReq({ locale: 'fr' });

    // First patch the join in the parked pages so that it
    // works in the original locale, that way we can test
    // later that it works after the import and the
    // ids have in fact been remapped
    return apos.docs.db.findOne({
      workflowLocale: 'fr',
      slug: '/about'
    })
    .then(function(about) {
      assert(about);
      oldAboutId = about._id;
      return apos.docs.db.update({
        workflowLocale: 'fr',
        slug: '/test'
      }, {
        $set: {
          'navigation.items.0.ids.0': oldAboutId
        }
      });
    })
    .then(function() {
      return apos.modules['apostrophe-site-review'].exportLocale(req);
    })
    .then(function(filename) {
      assert(filename);
      var fs = require('fs');
      assert(fs.existsSync(filename));
      exported = filename;
    });
  });

  it('should import a locale on request', function() {
    // import to different locale name for test purposes
    var req = apos.tasks.getReq({ locale: 'frimporttest' });
    return apos.modules['apostrophe-site-review'].importLocale(req, exported)
    .then(function() {
      return apos.docs.db.count({ workflowLocale: 'frimporttest' })
    })
    .then(function(n) {
      assert(n > 0);
      // Great, but did the remapping of join ids work?
      return apos.docs.db.findOne({
        workflowLocale: 'frimporttest',
        slug: '/about'
      })
    })
    .then(function(_about) {
      about = _about;
      assert(about._id !== oldAboutId);
      return apos.docs.db.findOne({
        workflowLocale: 'frimporttest',
        slug: '/test'
      });
    })
    .then(function(test) {
      assert(test.navigation);
      assert(test.navigation.items);
      assert(test.navigation.items[0]);
      assert(test.navigation.items[0].ids);
      assert(test.navigation.items[0].ids[0] !== oldAboutId);
      assert(test.navigation.items[0].ids[0] === about._id);
    });
  });

  it('insert an attachment', function(done) {
    return apos.attachments.insert(apos.tasks.getReq(), {
      path: __dirname + '/jack-o-lantern-head.jpg',
      name: 'jack-o-lantern-head.jpg'
    }, function(err, _attachment) {
      assert(!err);
      attachment = _attachment;
      assert(attachment);
      done();
    });
  });
    
  it('insert an image', function(done) {
    return apos.images.insert(apos.tasks.getReq({ locale: 'fr' }), {
      title: 'Jack O Lantern Head',
      attachment: attachment,
      published: true
    }, function(err, _image) {
      if (err) {
        console.error(err);
      }
      assert(!err);
      image = _image;
      assert(image);
      done();
    });
  });

  it('should configure a second, receiving site', function(done) {
    apos2 = require('apostrophe')({
      testModule: true,
      shortName: 'test2',
      modules: {
        'apostrophe-pages': {
          park: [
            {
              slug: '/test',
              type: 'testPage',
              navigation: {
                type: 'area',
                items: [
                  {
                    type: 'navigation',
                    _id: 'xyz',
                    by: 'id',
                    ids: [ 'placeholder' ]
                  }
                ]
              }
            },
            {
              slug: '/about',
              type: 'testPage',
              title: 'About'
            }
          ],
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
        'apostrophe-site-review': {
          receiveFrom: {
            apikey: 'testtest'
          }
        },
        'apostrophe-express': {
          port: 7001
        },
        'apostrophe-attachments': {
          uploadfs: {
            uploadsPath: __dirname + '/public/uploads2',
            uploadsUrl: '/public/uploads2',
            tempPath: __dirname + '/data/temp/uploadfs2'
          }
        }
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

  it('should export attachments', function() {
    var siteReview = apos.modules['apostrophe-site-review'];
    return siteReview.deployAttachments()
    .then(function() {
      return apos2.attachments.db.findOne({ _id: attachment._id })
    })
    .then(function(received) {
      assert(received);
      assert(fs.existsSync(__dirname + '/public/uploads2' + apos2.attachments.url(received, { uploadfsPath: true })));
    });
  });
});
