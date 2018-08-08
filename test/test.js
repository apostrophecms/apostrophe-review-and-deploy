var assert = require('assert');
var fs = require('fs');

describe('apostrophe-review-and-deploy', function() {

  var apos;
  var apos2;
  var exported;
  var oldAboutId;
  var attachment;    
  
  this.timeout(5000);
  
  after(function(done) {
    require('apostrophe/test-lib/util').destroy(apos, function() {
      require('apostrophe/test-lib/util').destroy(apos2, done);
    });
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
              title: 'About',
              published: true
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
        'apostrophe-review-and-deploy': {
          deployTo: {
            baseUrl: 'http://localhost:7001',
            prefix: '',
            apikey: 'testtest'
          }
        }
      },
      afterInit: function(callback) {
        assert(apos.modules['apostrophe-review-and-deploy']);
        return callback(null);
      },
      afterListen: function(err) {
        done();
      }
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
      baseUrl: 'http://localhost:7001',
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
        'apostrophe-review-and-deploy': {
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
        assert(apos.modules['apostrophe-review-and-deploy']);
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
      return apos.modules['apostrophe-review-and-deploy'].exportLocale(req);
    })
    .then(function(filename) {
      assert(filename);
      var fs = require('fs');
      assert(fs.existsSync(filename));
      exported = filename;
    });
  });
  
  it('should import a locale on request', function() {
    var req = apos2.tasks.getReq({ locale: 'fr' });
    return apos2.modules['apostrophe-review-and-deploy'].importLocale(req, exported)
    .then(function() {
      return apos2.docs.db.count({ workflowLocale: 'fr' })
    })
    .then(function(n) {
      assert(n > 0);
      // Great, but did the remapping of join ids work?
      return apos2.docs.db.findOne({
        workflowLocale: 'fr',
        slug: '/about'
      })
    })
    .then(function(_about) {
      about = _about;
      assert(about._id !== oldAboutId);
      return apos2.docs.db.findOne({
        workflowLocale: 'fr',
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

  it('should get corresponding production URL of page', function() {
    var review = apos.modules['apostrophe-review-and-deploy'];
    var req = apos2.tasks.getReq({ locale: 'fr' });
    return apos2.pages.find(req, { slug: '/about' }).toObject().then(function(about) {
      return review.getProductionUrl(req, about).then(function(url) {
        assert(url === 'http://localhost:7001/about');
      });
    })
  });

  it('should export attachments', function() {
    var siteReview = apos.modules['apostrophe-review-and-deploy'];
    return siteReview.deployAttachments('fr')
    .then(function() {
      return apos2.attachments.db.findOne({ _id: attachment._id })
    })
    .then(function(received) {
      assert(received);
      assert(fs.existsSync(__dirname + '/public/uploads2' + apos2.attachments.url(received, { uploadfsPath: true })));
    });
  });

});
