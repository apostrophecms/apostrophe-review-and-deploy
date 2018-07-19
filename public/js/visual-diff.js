$('iframe').load( function() {
     $('iframe').contents().find("head")
     .append($("<style type='text/css'>  .header{display:none;}  </style>"));
});
