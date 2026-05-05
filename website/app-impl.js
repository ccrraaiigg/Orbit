// Exported as a factory so the installed extension's <ext>/app.js shim can
// require('vscode') from within the extension directory and pass it in.
// See website/src/extension.js for the analogous explanation.
module.exports = function (_vscode) {
var createError = require('http-errors');
var express = require('express');
var path = require('path');
var cookieParser = require('cookie-parser');
var logger = require('morgan');

var indexRouter = require('./routes/index');
var usersRouter = require('./routes/users');
var secretsRouter = require('./routes/secrets');
var orbitRouter = require('./routes/orbit');

var app = express();

// view engine setup
app.set('views', path.join(__dirname, 'views'));
app.set('view engine', 'jade');

app.use(logger('dev'));
app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));

app.use('/', indexRouter);
app.use('/users', usersRouter);
app.use('/secrets', secretsRouter);
app.use('/orbit', orbitRouter);

// Clipboard bridge: the VS Code Integrated Browser swallows native Cmd+V
// and refuses navigator.clipboard.readText permission. Expose
// vscode.env.clipboard via HTTP so the page can drive copy/paste through
// the host. When running outside the extension host, vscode is not
// available and this endpoint reports a 503.
app.get('/clipboard', async (req, res) => {
  if (!_vscode) return res.status(503).json({ error: 'vscode API unavailable' });
  try {
    const text = await _vscode.env.clipboard.readText();
    res.json({ text });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
app.post('/clipboard', async (req, res) => {
  if (!_vscode) return res.status(503).json({ error: 'vscode API unavailable' });
  try {
    const text = (req.body && typeof req.body.text === 'string') ? req.body.text : '';
    await _vscode.env.clipboard.writeText(text);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// catch 404 and forward to error handler
app.use(function(req, res, next) {
  next(createError(404));
});

// error handler
app.use(function(err, req, res, next) {
  // set locals, only providing error in development
  res.locals.message = err.message;
  res.locals.error = req.app.get('env') === 'development' ? err : {};

  // render the error page
  res.status(err.status || 500);
  res.render('error');
});

return app;
};

