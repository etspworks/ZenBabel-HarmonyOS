# Conversion toolbox for convert.sh: the Python exporter and the MindSpore Lite converter (linux-x64 only).
FROM --platform=linux/amd64 python:3.11-slim
RUN pip install --no-cache-dir 'torch==2.5.1' --index-url https://download.pytorch.org/whl/cpu \
 && pip install --no-cache-dir 'transformers==4.46.3' 'onnx==1.17.0' 'onnxruntime==1.20.1' sentencepiece 'numpy<2'
ADD --checksum=sha256:8bb1097100c9fec12675670ba2d4264a2cd6da3a9be093eb56631d00fc0c455b \
  https://ms-release.obs.cn-north-4.myhuaweicloud.com/2.7.0/MindSporeLite/lite/release/linux/x86_64/mindspore-lite-2.7.0-linux-x64.tar.gz /opt/mslite.tar.gz
RUN tar xzf /opt/mslite.tar.gz -C /opt && rm /opt/mslite.tar.gz && mv /opt/mindspore-lite-2.7.0-linux-x64 /opt/mslite
ENV LD_LIBRARY_PATH=/opt/mslite/tools/converter/lib:/opt/mslite/runtime/lib
# For linux/engine_check: builds the app's engine source against the Linux MindSpore Lite runtime.
RUN apt-get update && apt-get install -y --no-install-recommends g++ cmake make && rm -rf /var/lib/apt/lists/*
