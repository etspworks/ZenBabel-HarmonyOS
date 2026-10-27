// Maps the HarmonyOS MindSpore Lite C API (OH_AI_*) onto the upstream Linux package (MS*), so the app's
// engine source builds unchanged for engine_check on Linux.
#pragma once
#include "c_api/context_c.h"
#include "c_api/model_c.h"
#include "c_api/tensor_c.h"

#define OH_AI_ModelHandle MSModelHandle
#define OH_AI_ContextHandle MSContextHandle
#define OH_AI_TensorHandle MSTensorHandle
#define OH_AI_TensorHandleArray MSTensorHandleArray
#define OH_AI_ShapeInfo MSShapeInfo
#define OH_AI_STATUS_SUCCESS kMSStatusSuccess
#define OH_AI_DEVICETYPE_CPU kMSDeviceTypeCPU
#define OH_AI_MODELTYPE_MINDIR kMSModelTypeMindIR
#define OH_AI_ContextCreate MSContextCreate
#define OH_AI_ContextDestroy MSContextDestroy
#define OH_AI_ContextSetThreadNum MSContextSetThreadNum
#define OH_AI_ContextAddDeviceInfo MSContextAddDeviceInfo
#define OH_AI_DeviceInfoCreate MSDeviceInfoCreate
#define OH_AI_ModelCreate MSModelCreate
#define OH_AI_ModelDestroy MSModelDestroy
#define OH_AI_ModelBuildFromFile MSModelBuildFromFile
#define OH_AI_ModelGetInputs MSModelGetInputs
#define OH_AI_ModelGetInputByTensorName MSModelGetInputByTensorName
#define OH_AI_ModelGetOutputByTensorName MSModelGetOutputByTensorName
#define OH_AI_ModelResize MSModelResize
#define OH_AI_ModelPredict MSModelPredict
#define OH_AI_TensorGetName MSTensorGetName
#define OH_AI_TensorGetShape MSTensorGetShape
#define OH_AI_TensorGetData MSTensorGetData
#define OH_AI_TensorGetMutableData MSTensorGetMutableData
#define OH_AI_TensorGetDataSize MSTensorGetDataSize
#define OH_AI_DeviceInfoHandle MSDeviceInfoHandle
#define OH_AI_DeviceInfoSetEnableFP16(device, on) ((void)(device), (void)(on))  // x86 has no FP16 kernels
#define OH_AI_TensorGetDataType MSTensorGetDataType
#define OH_AI_DATATYPE_NUMBERTYPE_FLOAT32 kMSDataTypeNumberTypeFloat32
