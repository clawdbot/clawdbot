"""WSGI entry point for the PropertyManager REST API.

Gunicorn target (WorkingDirectory = this directory)::

    gunicorn --config gunicorn.conf.py wsgi:application

Importing this module must not start a server, run migrations, spawn jobs,
mutate production data, or enable Flask debug/reloader.
"""

from __future__ import annotations

from propertymanager_api import app

application = app
