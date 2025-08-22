import axios from "axios";
const baseUrl = "https://api.siliconflow.cn/v1"
const headers = {
  'Content-Type': 'multipart/form-data',
  'Authorization': 'Bearer ' + import.meta.env.VITE_SILICONFLOW_API_KEY
}
const request = axios.create({
  baseURL: baseUrl,
  headers: headers
})
/**
 * 调用大模型识别语音
 * @param {FormData} data - 包含语音文件的 FormData 对象
 * @returns {Promise<{data: {text: string}}>}
 */
export const getAudioTranscriptions = async (data) => {
  try {
    const response = await request.post('/audio/transcriptions', data)
    return response.data
  } catch (error) {
    console.log('error', error);
  }
}
