# Web applications

Read [the web API contract](web-api.json) before implementation.
Only browser standard APIs and that common SDK are available, including when
running inside the desktop. Desktop files, models, Library, connectors, host
storage/appFiles and raw IPC are unavailable. A web application must not
implement an initial desktop-only dependency and defer compatibility to publishing.

Load /__orkas/sdk.js before application code and use window.orkasApp.
Only declared fields and operations are accessible to visitors. Define visibility
and business logic for the application; author management is a separate platform flow.
There is no visitor update/delete, arbitrary SQL or custom server program.

Desktop and online databases are separate. First publication starts empty;
updates preserve compatible online records. Bundled JSON is preloaded content,
not runtime records; use relative asset URLs. Visitor asset upload is unavailable.
Use browser fetch for external services under their CORS/authentication contract;
never put provider or author secrets into the bundle.

Catch structured SDK failures and keep controls usable for explicit retries.
Use a stable requestId for an insert the user explicitly retries; never replay an
uncertain write automatically. Capacity and permission failures must be visible.
