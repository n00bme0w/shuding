import json
import re
import sys

from funasr import AutoModel

model = AutoModel(model=sys.argv[1], trust_remote_code=True, disable_update=True, device="cpu")
result = model.generate(input=sys.argv[2], cache={}, language="zh", use_itn=True)
text = result[0]["text"]
text = re.sub(r"<\|[^|]+\|>", "", text).strip()
print(json.dumps({"text": text}, ensure_ascii=False))
