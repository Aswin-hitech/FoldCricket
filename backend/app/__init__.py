import os
from flask import Flask, send_from_directory

from .config import Config
from .extensions import cors, socketio


def create_app(config: type = Config) -> Flask:
    frontend_dist = os.path.abspath(
        os.path.join(os.path.dirname(__file__), "..", "..", "frontend", "dist")
    )
    has_frontend_build = os.path.exists(frontend_dist)

    app = Flask(
        __name__,
        static_folder=frontend_dist if has_frontend_build else None,
        static_url_path="",
    )
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

    # Serve React SPA if dist exists
    if has_frontend_build:
        @app.route("/", defaults={"path": ""})
        @app.route("/<path:path>")
        def serve_frontend(path: str):
            if path and os.path.exists(os.path.join(frontend_dist, path)):
                return send_from_directory(frontend_dist, path)
            return send_from_directory(frontend_dist, "index.html")

    return app

