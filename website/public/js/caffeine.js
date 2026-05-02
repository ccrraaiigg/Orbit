function dragElement(element, handle) {
  var deltaX = deltaY = x = y = 0

  handle.onmousedown = dragMouseDown

  function dragMouseDown(event) {
    event = event || window.event
    event.preventDefault()

    Array.from(document.querySelectorAll('body *')).map(element => element.style.zIndex = 0)
    window.document.getElementById('dashboard').style.zIndex = 2000

    this.style.zIndex = 1

    x = event.clientX
    y = event.clientY

    document.onmouseup = closeDragElement
    document.onmousemove = elementDrag}

  function elementDrag(event) {
    event = event || window.event
    event.preventDefault()

    deltaX = x - event.clientX
    deltaY = y - event.clientY
    x = event.clientX
    y = event.clientY

    element.style.top = (element.offsetTop - deltaY) + 'px'
    element.style.left = (element.offsetLeft - deltaX) + 'px'}

  function closeDragElement() {
    document.onmouseup = null
    document.onmousemove = null}}


function resizeElement(element) {
  // Create box in bottom-left.
  var resizer = document.createElement('div')

  resizer.id = 'resizeHandle'
  resizer.style.width = '10px'
  resizer.style.height = '10px'
  resizer.style.background = 'red'
  resizer.style.opacity = 0.5
  resizer.style.position = 'absolute'
  resizer.style.right = 0
  resizer.style.bottom = 0
  resizer.style.cursor = 'se-resize'

  // Append child to element.
  element.appendChild(resizer)

  // box function onmousemove
  resizer.addEventListener('mousedown', initResize, false)

  // window functions mousemove & mouseup
  function initResize(event) {
    element.onresizestart(event)
    window.addEventListener('mousemove', resize, false)
    window.addEventListener('mouseup', stopResize, false)}

  // Resize the element.
  function resize(event) {
    element.style.width = (event.clientX - element.offsetLeft) + 'px'
    element.style.height = (event.clientY - element.offsetTop) + 'px'
    element.onresize(event)}

  // On mouseup, remove window functions mousemove & mouseup.
  function stopResize(event) {
    window.removeEventListener('mousemove', resize, false)
    window.removeEventListener('mouseup', stopResize, false)
    element.onresizeend(event)}}


window.onload = function () {
  var embeddedSqueak = document.getElementById('embeddedSqueak'),
//      summary = document.getElementById('summary'),
      statustext = document.getElementById('status').children[0]

  statustext.style.textShadow = '1px 1px 1px #000'
  statustext.style.opacity = 0.5

  embeddedSqueak.onmouseenter = function () {
      document.getElementById('Caffeine').contentWindow.focus()}

  embeddedSqueak.onmouseleave = function () {
      window.focus()}
    
/*
  summary.onmousedown = function () {
    embeddedSqueak.style.zIndex = 1}

  summary.onmouseover = function () {
    embeddedSqueak.style.boxShadow = ''}
*/
  
  window.setTimeout(
    function () {
      window.scrollTo(0, 0)
      document.body.style.transition = 'all 1000ms'
      document.body.bgColor = ''},
    500)
  
  window.setTimeout(
    function () {
      var dashboard = window.document.getElementById('dashboard'),
	  spinner = window.document.getElementById('sqSpinner')

      window.progress.style.opacity = 1
      window.thestatus.style.opacity = 0.8
//      window.document.getElementById('summary').style.opacity = 1
	dashboard.style.opacity = 0.75},
    1500)
}

document.addEventListener('contextmenu', function(e) { e.preventDefault(); }, true);

// Hide the cursor while typing; restore on mouse movement.
(function() {
  var hidden = false;
  var modifierOnly = { Meta: 1, Shift: 1, Alt: 1, Control: 1, CapsLock: 1 };

  document.addEventListener('keydown', function(e) {
    if (hidden || modifierOnly[e.key]) return;
    document.documentElement.classList.add('cursor-hidden');
    hidden = true;
  }, true);

  document.addEventListener('mousemove', function() {
    if (!hidden) return;
    document.documentElement.classList.remove('cursor-hidden');
    hidden = false;
  }, true);

  var style = document.createElement('style');
  style.textContent = '.cursor-hidden, .cursor-hidden * { cursor: none !important; }';
  document.head.appendChild(style);
})();

