# Snowglobe server wiring

`keep/snowglobe/snowglobe-server.js` is the standalone copy. To
re-enable the `/snowglobe` echo proxy in the Orbit Node webserver:

1. Drop the file back at `website/src/snowglobe-server.js`.

2. In `website/app-impl.js`, immediately after the MCP-bridge block
   (`app.mcpBridge = mcpBridge;`), add:

   ```js
   // Snowglobe server: accepts the in-page Caffeine Snowglobe client at
   // /snowglobe and speaks the same wire protocol VW Snowglobe servers
   // do. See src/snowglobe-server.js.
   const { SnowglobeServer } = require('./src/snowglobe-server');
   const snowglobeServer = new SnowglobeServer();
   app.attachSnowglobeServer = function (server) {
     snowglobeServer.attachToHttpServer(server);
   };
   app.snowglobeServer = snowglobeServer;
   ```

3. In `website/bin/www`, right after the `attachMcpBridge` block, add:

   ```js
   if (typeof app.attachSnowglobeServer === 'function') {
     app.attachSnowglobeServer(server);
   }
   ```

4. In `website/src/extension-impl.js`, inside `startServer`, right
   after the `attachMcpBridge` block (around line 1388), add:

   ```js
   if (typeof app.attachSnowglobeServer === 'function') {
       try { app.attachSnowglobeServer(server); }
       catch (e) { orbitError('[orbit] attachSnowglobeServer failed:', e && e.message); }
   }
   ```

That's all the Orbit-webserver-side wiring; the rest of the Snowglobe
feature lives in the Squeak/Caffeine image
(`SnowglobeMorphicService` + `PasteUpMorph>>invalidRect:from:` hook
+ `JSSnowglobe class>>startSession`/`emitDisplayEventFor:rect:bits:`
patches).
