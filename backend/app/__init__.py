import os
from flask import Flask, jsonify, send_from_directory

from .config import Config
from .extensions import cors, socketio


def create_app(config: type = Config) -> Flask:
    frontend_dist = os.path.abspath(
        os.path.join(os.path.dirname(__file__), "..", "..", "frontend", "dist")
    )
    has_frontend_build = os.path.exists(frontend_dist)

    # Flask's built-in static route would shadow the SPA catch-all below and 404
    # every deep link (e.g. /room/<id>/arena) on refresh, so it is disabled.
    app = Flask(__name__, static_folder=None)
    app.config.from_object(config)

    # Extensions
    if config.CORS_ORIGINS == "*":
        cors.init_app(app, resources={r"/*": {"origins": "*"}})
    else:
        cors.init_app(app, origins=config.CORS_ORIGINS, supports_credentials=True)
    socketio.init_app(
        app,
        cors_allowed_origins=config.SOCKETIO_CORS_ALLOWED_ORIGINS,
        async_mode=config.SOCKETIO_ASYNC_MODE,
        ping_timeout=45,
        ping_interval=15,
        logger=False,
        engineio_logger=False,
    )

    # Blueprints
    from .api.health import bp as health_bp
    from .api.rooms import bp as rooms_bp
    from .api.telemetry import bp as telemetry_bp
    from .api.feedback import bp as feedback_bp

    app.register_blueprint(health_bp)
    app.register_blueprint(rooms_bp, url_prefix="/api")
    app.register_blueprint(telemetry_bp, url_prefix="/api")
    app.register_blueprint(feedback_bp, url_prefix="/api")

    # Socket handlers
    from .sockets import events  # noqa: F401 – registers handlers as a side effect

    # Set strict no-cache headers on all responses to prevent residual activity/caching after 1 hour
    @app.after_request
    def add_no_cache_headers(response):
        response.headers["Cache-Control"] = "no-cache, no-store, must-revalidate, max-age=0"
        response.headers["Pragma"] = "no-cache"
        response.headers["Expires"] = "0"
        return response

    # Serve React SPA if dist exists
    if has_frontend_build:
        @app.route("/", defaults={"path": ""})
        @app.route("/<path:path>")
        def serve_frontend(path: str):
            if path.startswith("api/"):
                return jsonify({"error": "not_found"}), 404
            if path.startswith("assets/"):
                # Hashed bundles must 404 rather than fall back to index.html
                return send_from_directory(frontend_dist, path)
            if path and os.path.exists(os.path.join(frontend_dist, path)):
                return send_from_directory(frontend_dist, path)
            return send_from_directory(frontend_dist, "index.html")

    return app

