$('[data-apos-visual-diff] iframe').on('load', function() {
  $('iframe').contents().find("head").append(
    $('<style type="text/css">.header{display:none;}</style>')
  );
});
