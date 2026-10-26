"""
Flask-SocketIO extension singleton.
"""

from flask_cors import CORS
from flask_socketio import SocketIO

socketio = SocketIO()
cors = CORS()
