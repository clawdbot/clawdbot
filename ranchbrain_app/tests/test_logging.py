from ranchbrain.logging_config import get_logger, LOG_FILE

def test_logger_creates_log_file():
    logger = get_logger("ranchbrain.test")
    logger.info("test log message")
    assert LOG_FILE.exists()
