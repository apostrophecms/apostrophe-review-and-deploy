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
