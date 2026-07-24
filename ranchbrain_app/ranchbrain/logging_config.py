import logging
from logging.handlers import RotatingFileHandler
from .config import RANCHBRAIN_DATA

LOG_DIR = RANCHBRAIN_DATA / "logs"
LOG_FILE = LOG_DIR / "ranchbrain.log"

def get_logger(name: str = "ranchbrain") -> logging.Logger:
    LOG_DIR.mkdir(parents=True, exist_ok=True)

    logger = logging.getLogger(name)
    logger.setLevel(logging.INFO)

    if logger.handlers:
        return logger

    formatter = logging.Formatter(
        "%(asctime)s | %(levelname)s | %(name)s | %(message)s"
    )

    file_handler = RotatingFileHandler(
        LOG_FILE,
        maxBytes=1_000_000,
        backupCount=5,
    )
    file_handler.setFormatter(formatter)

    logger.addHandler(file_handler)
    return logger
