"""OpenClaws Chinese Hardware Registry Mapping Layer."""
import logging
_LOGGER = logging.getLogger("openclaws.sovereign.zha_chinese")
class ChineseIoTRegistry:
    def __init__(self) -> None:
        self.supported_vendors = ["Tuya", "Aqara", "Xiaomi", "Gree", "Midea", "Loock", "Ecovacs"]
    def extract_vendor_profile(self, model_string: str) -> dict:
        if "智能锁" in model_string or "lock" in model_string.lower():
            return {"vendor": "Loock", "transport": "NB-IoT", "auth": "SIM-Crypt"}
        return {"vendor": "Generic", "transport": "WiFi-2.4G", "auth": "Default"}
