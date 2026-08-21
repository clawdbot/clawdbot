import re
import sys
import json

def redact_text(text):
    # SSN pattern
    ssn_pattern = r'\b\d{3}-\d{2}-\d{4}\b'
    # Credit Card pattern
    cc_pattern = r'\b(?:\d[ -]*?){13,16}\b'
    # Email pattern
    email_pattern = r'\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b'
    
    redacted = text
    redacted = re.sub(ssn_pattern, "[REDACTED_SSN]", redacted)
    redacted = re.sub(cc_pattern, "[REDACTED_FINANCIAL]", redacted)
    redacted = re.sub(email_pattern, "[REDACTED_EMAIL]", redacted)
    
    return redacted

if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: python redact.py <text>")
        sys.exit(1)
        
    input_text = sys.argv[1]
    result = redact_text(input_text)
    print(result)
