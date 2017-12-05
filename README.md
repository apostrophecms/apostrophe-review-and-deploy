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
    // REQUIRED for use of apostrophe-site-review.
  },
  'apostrophe-site-review': {}
}
```

## Reviewing Sites

Once the module is enabled, a "Review" button will appear in the admin bar.

*Currently only sitewide admins may initiate, complete and deploy content via reviews. TODO: add more nuance, but keep in mind the implications of being able to push an entire locale live to production.*

As a sitewide admin, click "Reviews," then "Add Review." Give the review a title, such as "September review of en locale."

Choose a locale to be reviewed. If you are using `apostrophe-workflow` for workflow only, then there will only be one option. If your site is configured for multiple locales via `apostrophe-workflow`, you will need to choose a locale for this review.

Click "Save" to begin the review.

**From this point on, users may not make any modifications to the live version of the content for this locale.** Draft content may still be edited, but commits and operations such as movement in the page tree are **blocked for the duration of the review.** This ensures that a document cannot be modified between the time of its approval and the time the rest of the content is fully approved and deployed.

**Once the review is in progress, an "Under Review" message will appear for everyone with editing privileges for the content.** In addition, users with permission to contribute to the review will see buttons to approve or reject the documents visible on the page.

As a compromise between strictness and productivity, approving a page approves all of the content both on that page and on any related documents, such as images, whose content is directly visible on it via widgets.

As users approve documents, they will automatically progress through the site. The review process begins with pages, then cycles through pieces not already approved. For instance, older blog articles not currently appearing on page one of your site's blog will not be implicitly approved with the page, so they will be reviewed individually.

**Review progresses through piece types in the order they were configured, with two exceptions: images, files and the global doc are reviewed last.** To change this order, use the following option:

```javascript
// in app.js

modules: {
  'apostrophe-site-review': {
    approvalOrder: [ 'blog', 'event', 'apostrophe-image' ]
  }
}
```

**The strings configured for `approvalOrder` must match the `name` option of the piece type in question.** They are *not* module names. Anything not mentioned in `approvalOrder` is reviewed *last*.

**If a piece appears on the "show" page for another piece via a widget or join, it is implicitly approved too.** You can take advantage of `approvalOrder` to maximize the chances of this happening.

### Content that is not locale-specific

Certain document types might be marked as not specific to a locale. Such document types are thus a required part of **every** review, as otherwise they would not be reviewed before deployment of content that depends on them.

> Even with this feature, the use of non-locale-specific document types may still present problems for other locales after deployment of approved changes for a single locale. Consider what happens if a non-locale-specific document moves to the trash, meeting the expectations of one locale that has been deployed, but not yet the expectations of others. To prevent "chicken and egg" problems we do not recommend the use of non-locale-specific content types except for those which are necessary to the operation of the system, specifically users and groups.

### Rejecting a Review

**If any document is rejected, the entire review is rejected, and the review process ends.** It remains accessible in the "Manage Reviews" list for later study.

### Creating reviews while another review is active

You may not create a new review while another is still in progress for the same locale.

### Completing a Review

When a review is completed, it will be marked as such and will remain available in the "Manage Reviews" dialog box. Read on to see how you can take advantage of this module's deployment features to "ship" the approved content to another server at this point. 

## Deploying Content

### Configuration

To deploy content to another host at the end of an approved site review, you'll need to configure the module for that:

```javascript
// in app.js, on the SENDING server,
// where the review happened

modules: {
  'apostrophe-site-review': {
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
  'apostrophe-site-review': {
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

If a decision is made to roll back a deployment, this can be done by accessing the review via "Manage Reviews" and clicking the "Roll Back" button.

This will trigger an API request to the receiving site asking it to remove the content and make the previous content live again.

*Only the most recent deployment may be rolled back.* However, after rolling back a deployment it is possible to roll back to the next one. Note that the number of past deployments actually kept by the receiving site is controlled by the `rollback` option.

## Implementation notes

### Avoiding race conditions

This module is implemented in such a way that users never see a mix of old and new content, not even in the middle of the deployment, to the extent this is possible with MongoDB.

Specifically, the new content is inserted using a special temporary locale setting that prevents it from appearing at first. When the content has been completely updated, the old content's locale settings are "flipped" to an archival local name, and the new content's locale settings are set to the live locale name.

The only race condition possible is during the update operations to change the locale name. This is a single MongoDB operation and should be very fast, but could take a few seconds on sites with thousands of documents.

To address this, the module provides special middleware that keeps requests "on hold" until this final changeover completes.

An additional benefit is that if a deployment fails, there is no impact on end users. The content in the temporary locale is simply removed.

And, of course, the use of archival locale names allows for rollback of deployments.

### `_id` conflicts

All of this sounds good, but the `_id` property is still a problem. `_id` must always be unique, even between locales (a fundamental rule of MongoDB), and the incoming `_id` properties will conflict with the existing ones. It is impossible to change the `_id` of an existing document in MongoDB.

Our solution: **change _id before inserting the new documents.** This avoids the conflict, but requires that we resolve and change every _id in all joins, which adds complexity. On the plus side, it can be done entirely during the insert process using synchronous logic previously written, which means it doesn't add much runtime, and it is then already in place before the locales are switched to make the new documents live. However **Any references to the document from documents in other locales, or from documents independent of workflow, will fail.** Currently there is no UI in Apostrophe that would encourage the creation of either of these situations.

### Deploying media

Media is included in the deployment process. New attachments are "pushed out" as part of the sync process. Attachment status/permissions changes (e.g. the document they are a part of is now in the trash) are also pushed. And if the list of available image sizes has been changed between deployments, an MD5 hash of the `sizes` configuration in use is used to detect this situation. If it does not match after deployment for an image attachment, the attachment's scaled versions are regenerated.
