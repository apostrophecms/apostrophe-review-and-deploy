## 2.4.0

Unit tests passing.

* Rollback is now supported. The rollback button appears with the "Cancel" and "Finished" button in the "Manage Reviews" modal. It is not a per-review button because it would be misleading, as it can only roll back the most recent review deployed, and cannot know for certain that it even came from the same source server.
* Attachment permissions are now handled properly. That is, whether they are available for access by the browser is correctly computed based on the docs present on the server deployed to, without making assumptions that only hold on the sending server.

## 2.3.1

Unit tests passing.

* Pieces are considered context before pages, just like with workflow.
* Correct URL generation for comparisons, bypasses issues with protocol-relative `baseUrl` settings.
* Efficient algorithm to skip docs with no `_url`. Avoids appearance of outright failure when this takes many minutes on a large database.
* `prefix` option no longer mandatory on deployment targets, treated as empty string if absent.

## 2.3.0

Unit tests passing.

* Implemented backstop-based display of changes between preprod and live sites.

## 2.2.2

Unit tests passing.

* Browser-side js no longer throws an error if workflow is not active
on the page (example: `/login`). No other changes.

## 2.2.1

Unit tests passing.

Regression tests passing.

* The percentage of completion is now proof against double-reporting, which should prevent percentages in excess of 100%.
* The percentage of completion is formatted in a readable fashion (only two digits after decimal point).

## 2.2.0

Unit tests passing.

Regression tests passing.

* An indication is now given during the review process if the current page, or something on it, is believed to have been committed since the last deployment of the current locale.

* Do not crash if a locale has never been deployed before.

## 2.1.0

Unit tests passing.

Regression tests passing.

Support for deploying to multiple servers.

## 2.0.0

Unit tests passing.

Regression tests passing.

Initial release.
