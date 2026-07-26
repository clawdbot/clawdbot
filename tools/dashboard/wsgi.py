"""WSGI entry point for the deployment-local OpenClaw dashboard."""

from tools.dashboard.app import app

application = app
