Require an approval process for the entire site, or one locale, then push the site's content from "pre-production" to production on another host.

"Doesn't [apostrophe-workflow](https://npmjs.org/package/apostrophe-workflow) cover this use case?"

It does if you're comfortable with changes to one document being committed and made live without a comprehensive review of "ripple effects" on the rest of the site.

But for those who require a "waterfall" review process before all of the content is truly live in production, this module is a valuable tool *in addition to* `apostrophe-workflow`.

## Installation

```javascript
// in app.js

modules: {
  'apostrophe-workflow': {
    // See documentation for this module.
    // REQUIRED for use of apostrophe-review-and-deploy.
  },
  'apostrophe-review-and-deploy': {}
}
```

## Reviewing Sites

Once the module is enabled, a "Review" button will appear in the admin bar.

*Currently only sitewide admins may initiate, complete and deploy content via reviews. TODO: add more nuance here, but keep in mind the considerable implications of being able to push an entire locale live to production.*

As a sitewide admin, click "Reviews," then "Add Review." Give the review a title, such as "September review of en locale."

Choose a locale to be reviewed. If you are using `apostrophe-workflow` for workflow only, then there will only be one option. If your site is configured for multiple locales via `apostrophe-workflow`, you will need to choose a locale for this review.

Click "Save" to begin the review.

**From this point on, users may not make any modifications to the live version of the content for this locale.** Draft content may still be edited, but commits and operations such as movement in the page tree are **blocked for the duration of the review.** This ensures that a document cannot be modified between the time of its approval and the time the rest of the content is fully approved and deployed.

**Once the review is in progress, admins will see "Approve" and "Reject" buttons for review purposes when viewing pages in live mode.** 

Since the purpose of the review is to check how documents appear "in context" on a page,  approving a page approves all of the content both on that page and on any related documents, such as images, whose content is directly visible on it via widgets.

As admins approve documents, they will automatically progress through the site. The review process begins with pages, then cycles through pieces not already approved. For instance, older blog articles not currently appearing on page one of your site's blog will not be implicitly approved with the page, so they will be reviewed individually.

**Review progresses through piece types in the order they were configured, with two exceptions: images, files and the global doc are reviewed last.** To change this order, use the following option:

```javascript
// in app.js

modules: {
  'apostrophe-review-and-deploy': {
    approvalOrder: [ 'blog', 'event', 'apostrophe-image' ]
  }
}
```

**The strings configured for `approvalOrder` must match the `name` option of the piece type in question.** They are *not* module names. Anything not mentioned in `approvalOrder` is reviewed *last*.

**If a piece appears on the "show" page for another piece via a widget or join, it is implicitly approved too.** You can take advantage of `approvalOrder` to maximize the chances of this happening.

**If a piece has no "show" page and is not otherwise detected as "in context" on a page somewhere on the site via joins or widgets,** it is not included in the review process.

### Content that is not locale-specific

Certain document types might be marked as not specific to a locale. Such documents are **not reviewed**. By default the only document types that are not localized are users and groups.

While it is possible to configure workflow-exempt piece types in `apostrophe-workflow`, consider what happens if a non-locale-specific document moves to the trash, meeting the expectations of one locale that has been deployed, but not yet the expectations of others. To prevent "chicken and egg" problems we do not recommend the use of non-locale-specific content types except for those which are necessary to the operation of the system, specifically users and groups.

### Rejecting a Review

**If any document is rejected, the entire review is rejected, and the review process ends.** It remains accessible in the "Manage Reviews" list for later study.

### Creating reviews while another review is active

Any reviews for the same locale already in progress or "ready to deploy" are marked as "superseded" in this situation and cannot be continued.

### Completing a Review

When a review is completed, it will be marked as such in "Manage Reviews." Read on to see how you can take advantage of this module's deployment features to "deploy" the approved content to another server at this point. 

## Deploying Content

### Configuration

To deploy content to another host at the end of an approved site review, you'll need to configure the module for that:

```javascript
// in app.js, on the SENDING server,
// where the review happened

modules: {
  'apostrophe-review-and-deploy': {
    deployTo: {
      // Should match the `baseUrl` option of the
      // other site
      baseUrl: 'https://YOUR-PROD-SITE-NAME.com',
      // If the receiving site uses the global Apostrophe
      // `prefix` feature to serve itself as a virtual folder
      prefix: '',
      apikey: 'XXXXXXXXX'
    }
  }
}
```

```javascript
// in app.js, on the RECEIVING server,
// where the content will become live

modules: {
  'apostrophe-review-and-deploy': {
    receiveFrom: {
      // The other site must present this API key
      apikey: 'XXXXXXXXX',
      // You may roll back this many deployments
      rollbackSnapshots: 5
    }
  }
}
```

> **For security reasons, the receiving site MUST be contacted by the sending site via https, never http.** You can override this by setting the `insecure` option to `true`, in which case a very prominent warning is displayed on the console. Use this only for testing.

### Deploying reviewed content

Once these options are in place, a completed review will be listed as "Deployable." A user with permission to participate in the review may then click on that review in the "manage reviews" dialog box, then click the "Deploy" button.

The content will be deployed to the receiving site and become live. This process may take considerable time depending on the size of the site.

### Rolling back deployments

Currently previous content is correctly migrated to a "rollback locale" for later restoration, but the UI for rolling it back does not yet exist (TODO: implement this).

The number of past deployments kept for rollback is controlled by the `rollback` option, which defaults to `5`.

## Implementation notes

### Avoiding race conditions

This module is implemented in such a way that users never see a mix of old and new content, not even in the middle of the deployment, to the extent this is possible with MongoDB.

Specifically, the new content is inserted using a special temporary locale setting that prevents it from appearing at first. When the content has been completely updated, the old content's locale settings are "flipped" to an archival local name, and the new content's locale settings are set to the live locale name.

The only race condition possible is during the update operations to change the locale name. This is a single MongoDB operation and should be very fast, but could take a few seconds on sites with thousands of documents.

An additional benefit is that if a deployment fails, there is no impact on end users. The content in the temporary locale is simply ignored.

TODO: consider implementing special middleware that keeps requests "on hold" until this final changeover completes. This would require a flag in the `global` doc.

### `_id` conflicts

All of this sounds good, but the `_id` property is still a problem. `_id` must always be unique, even between locales (a fundamental rule of MongoDB), and the incoming `_id` properties will conflict with the existing ones. It is impossible to change the `_id` of an existing document in MongoDB.

Our solution: **change _id before inserting the new documents.** This avoids the conflict, but requires that we resolve and change every _id in all joins, which adds complexity. On the plus side, it can be done entirely during the insert process using synchronous logic previously written, which means it doesn't add much runtime, and it is then already in place before the locales are switched to make the new documents live. However **Any references to the document from documents in other locales, or from documents independent of workflow, will fail.** Currently there is no UI in Apostrophe that would encourage the creation of either of these situations.

### Deploying media

Media is included in the deployment process. New attachments are "pushed out" as part of the sync process. Attachment status/permissions changes (e.g. the document they are a part of is now in the trash) are also pushed. If it does not match after deployment for an image attachment, the attachment's scaled versions are regenerated.

TODO: if the list of available image sizes has been changed between deployments, an MD5 hash of the `sizes` configuration in use should be used to detect this situation.
