import { ref, onUnmounted, computed } from 'vue'
import { getAudioTranscriptions } from '@/api'

// 响应式变量
const error = ref('')
const status = ref('未初始化') // 语音识别状态
const talkText = ref('') // 识别到的文本
const permissionStatus = ref('init') // 权限状态
const isRecording = ref(false) // 是否正在录音
const conversationHistory = ref([]) // 对话历史

let silenceTimer = null // 静音计时器
let restartTimer = null // 识别计时器
// 内部状态变量
let recognition = null // SpeechRecognition实例
let mediaRecorder = null // 媒体记录器实例
let audioContext = null // 音频上下文
let audioChunks = [] // 临时存储录音数据
let animationFrameId = null // 动画帧ID，用于音量检测
let isListening = false // 是否正在监听唤醒词
let isPromptDetected = false // 是否检测到唤醒词
let isWaitingForResponse = false // 是否正在等待大模型响应

// 常量
const WAKE_WORD = '小瞳小瞳' // 唤醒词
const SILENCE_TIMEOUT = 1500 // 静音超时时间(ms)
const AUDIO_ENERGY_THRESHOLD = 20 // 音量阈值

// 兼容性处理
const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;

/**
 * 请求麦克风权限并开始录音
 * @returns {Promise<void>} - 无返回值
 */
const requestPermissionAndStartRecording = async () => {
  error.value = ''
  isPromptDetected = true // 标记已检测到唤醒词

  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
    permissionStatus.value = 'granted'
    status.value = '录音准备中'
    console.log('成功获取麦克风权限')

    startRecording(stream)
  } catch (err) {
    console.error('获取麦克风权限失败:', err)
    permissionStatus.value = 'denied'
    isPromptDetected = false // 重置唤醒词检测状态

    switch (err.name) {
      case 'NotAllowedError':
        error.value = '用户拒绝了麦克风权限'
        break
      case 'NotFoundError':
        error.value = '未找到麦克风设备'
        break
      case 'NotSupportedError':
        error.value = '浏览器不支持麦克风访问'
        break
      default:
        error.value = '获取麦克风权限失败: ' + err.message
    }

    status.value = '获取麦克风权限失败: ' + error.value
  }
}

/**
 * 开始录音
 * 当检测到静音超过设定时间后自动停止录音
 * @param {MediaStream} stream - 音频流
 */
const startRecording = (stream) => {
  // 重置状态
  audioChunks = []
  clearTimeout(silenceTimer)
  status.value = '录音中'
  isRecording.value = true

  // 创建媒体记录器
  mediaRecorder = new MediaRecorder(stream, { mimeType: 'audio/webm' })

  mediaRecorder.ondataavailable = (e) => {
    if (e.data.size > 0) {
      audioChunks.push(e.data)
    }
  }

  mediaRecorder.onstop = () => {
    const audioBlob = new Blob(audioChunks, { type: 'audio/webm' })

    // 清理资源
    cleanupRecordingResources(stream)

    // 调用大模型识别语音
    processAudioWithModel(audioBlob)
  }

  mediaRecorder.onerror = (err) => {
    console.error('媒体记录器错误:', err)
    error.value = '录音失败: ' + err.error
    status.value = '录音失败'
    cleanupRecordingResources(stream)
  }

  // 创建音频上下文分析音量
  setupAudioEnergyMonitoring(stream)

  // 开始录音
  mediaRecorder.start()
  console.log('开始录音')

  // 初始设置静音计时器
  resetSilenceTimer()
}

/**
 * 清理录音相关资源
 * @param {MediaStream} stream - 音频流
 */
const cleanupRecordingResources = (stream) => {
  // 停止所有音轨
  stream.getTracks().forEach(track => track.stop())

  // 释放资源
  if (mediaRecorder) {
    mediaRecorder = null
  }

  if (audioContext) {
    audioContext.close()
    audioContext = null
  }

  clearTimeout(silenceTimer)

  if (animationFrameId) {
    cancelAnimationFrame(animationFrameId)
    animationFrameId = null
  }

  isRecording.value = false
  isPromptDetected = false // 重置唤醒词检测状态
}

/**
 * 设置音量监测
 * @param {MediaStream} stream - 音频流
 */
const setupAudioEnergyMonitoring = (stream) => {
  try {
    audioContext = new (window.AudioContext || window.webkitAudioContext)()
    const analyser = audioContext.createAnalyser()
    const microphone = audioContext.createMediaStreamSource(stream)

    analyser.fftSize = 1024
    microphone.connect(analyser)

    // 使用requestAnimationFrame监测音量
    const checkAudioEnergy = () => {
      if (!mediaRecorder || mediaRecorder.state !== 'recording') {
        return
      }

      const array = new Uint8Array(analyser.frequencyBinCount)
      analyser.getByteFrequencyData(array)

      // 计算音量平均值
      const averageEnergy = array.reduce((sum, value) => sum + value, 0) / array.length

      // 如果音量大于阈值，认为有声音
      if (averageEnergy > AUDIO_ENERGY_THRESHOLD) {
        resetSilenceTimer()
      }

      // 继续请求下一帧
      animationFrameId = requestAnimationFrame(checkAudioEnergy)
    }

    // 启动能量检测循环
    animationFrameId = requestAnimationFrame(checkAudioEnergy)
  } catch (err) {
    console.error('创建音频上下文失败:', err)
    error.value = '音频分析初始化失败: ' + err.message
  }
}

/**
 * 重置静音计时器
 */
const resetSilenceTimer = () => {
  clearTimeout(silenceTimer)
  silenceTimer = setTimeout(() => {
    if (mediaRecorder?.state === 'recording') {
      console.log('静音超时，自动停止录音')
      status.value = '静音超时，自动停止录音'
      mediaRecorder.stop()
    }
  }, SILENCE_TIMEOUT)
}

/**
 * 调用大模型处理音频
 * @param {Blob} audioBlob - 音频Blob对象
 */
const processAudioWithModel = (audioBlob) => {
  if (isWaitingForResponse) {
    console.log('已有请求正在处理中，忽略当前请求')
    return
  }

  isWaitingForResponse = true
  status.value = '正在识别...'

  const formData = new FormData()
  formData.append('file', audioBlob)
  formData.append('model', 'FunAudioLLM/SenseVoiceSmall')

  getAudioTranscriptions(formData)
    .then(res => {
      console.log('【大模型识别结果】', res.data)
      const recognizedText = res.data?.text || ''
      talkText.value = recognizedText

      // 添加到对话历史
      if (recognizedText) {
        conversationHistory.value.push({
          type: 'user',
          text: recognizedText,
          timestamp: new Date().toISOString()
        })
      }

      status.value = '大模型识别成功'
    })
    .catch(err => {
      console.error('大模型识别失败:', err)
      error.value = '识别失败: ' + (err.message || '未知错误')
      status.value = '大模型识别失败'
    })
    .finally(() => {
      isWaitingForResponse = false
    })
}

/**
 * 处理语音识别结果
 * @param {SpeechRecognitionEvent} event - 语音识别事件对象
 */
const handleRecognitionResult = (event) => {
  const lastResult = event.results[event.results.length - 1]
  const transcript = lastResult[0].transcript.trim()
  console.log('原生API识别结果:', transcript)

  if (!isPromptDetected && !isRecording.value) {
    // 检查是否包含唤醒词
    if (transcript.includes(WAKE_WORD)) {
      isPromptDetected = true
      status.value = '检测到唤醒词，准备录音'
      console.log('检测到唤醒词，准备录音')
      // 调用函数开始录音
      requestPermissionAndStartRecording()
    }
  }
}

/**
 * 语音识别自定义hook
 * 提供语音识别的初始化、启动、停止功能，以及状态和识别文本的响应式变量
 * @returns {Object} 包含状态、识别文本和控制方法的对象
 */
export const useSTT = () => {
  // 标记是否已经初始化
  let isInitialized = false

  /**
   * 初始化语音识别
   * 设置语音识别器的参数和事件监听器
   * @returns {boolean} 初始化是否成功
   */
  const init = () => {
    // 避免重复初始化
    if (isInitialized) {
      return true
    }

    // 检查浏览器是否支持SpeechRecognition
    if (!SpeechRecognition) {
      error.value = '浏览器不支持语音识别API'
      status.value = '浏览器不支持语音识别'
      console.log('浏览器不支持语音识别API');
      return false
    }

    // 检查浏览器是否支持getUserMedia
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      error.value = '浏览器不支持 getUserMedia API'
      status.value = '浏览器不支持 getUserMedia API'
      console.log('浏览器不支持 getUserMedia API');
      return false
    }

    // 初始化语音识别器
    initRecognition();
    isInitialized = true
    return true
  }

  /**
   * 初始化语音识别器实例
   */
  const initRecognition = () => {
    // 创建语音识别实例
    recognition = new SpeechRecognition()
    recognition.continuous = true
    recognition.interimResults = true
    recognition.lang = 'zh-CN' // 设置为中文识别
    recognition.maxAlternatives = 1

    // 设置事件监听器
    recognition.onresult = handleRecognitionResult
    recognition.onerror = handleRecognitionError
    recognition.onend = handleRecognitionEnd

    status.value = '已初始化'
    console.log('语音识别已初始化')
  }

  /**
   * 处理语音识别错误
   * @param {SpeechRecognitionErrorEvent} event - 语音识别错误事件
   */
  const handleRecognitionError = (event) => {
    console.error('语音识别错误:', event.error)

    switch (event.error) {
      case 'not-allowed':
        error.value = '语音识别权限被拒绝'
        permissionStatus.value = 'denied'
        break
      case 'service-not-available':
        error.value = '语音识别服务不可用'
        break
      case 'network':
        error.value = '网络错误导致语音识别失败'
        break
      case 'no-speech':
        error.value = '没有检测到语音'
        break
      default:
        error.value = "未处理的错误" + event.error
    }

    status.value = '语音识别错误: ' + error.value

    // 尝试重启识别
    restartRecognition()
  }

  /**
   * 处理语音识别结束事件
   */
  const handleRecognitionEnd = () => {
    // 自动重启识别
    restartRecognition()
  }

  /**
   * 重启语音识别
   */
  const restartRecognition = () => {
    if (isListening) {
      clearTimeout(restartTimer)
      restartTimer = setTimeout(() => {
        recognition.start()
      }, 300)
    }
  }

  /**
   * 启动语音识别监听
   * 请求麦克风权限并开始识别唤醒词
   * @returns {Promise<boolean>} 返回启动是否成功的Promise
   */
  const start = () => {
    return new Promise((resolve) => {
      // 确保已经初始化
      if (!isInitialized) {
        if (!init()) {
          console.log(333);

          resolve(false)
          return
        }
      }

      if (recognition && !isListening) {
        isListening = true
        status.value = '监听中'
        console.log('开始监听');

        // 请求麦克风权限并启动识别
        navigator.mediaDevices.getUserMedia({ audio: true })
          .then(() => {
            permissionStatus.value = 'granted'
            recognition.start()
            resolve(true)
          })
          .catch(err => {
            console.error('获取麦克风权限失败:', err)
            permissionStatus.value = 'denied'
            isListening = false
            if (err.name === 'NotAllowedError') {
              error.value = '用户拒绝了麦克风权限'
            } else if (err.name === 'NotFoundError') {
              error.value = '未找到麦克风设备'
            } else {
              error.value = '获取麦克风权限失败: ' + err.message
            }
            status.value = '获取麦克风权限失败: ' + error.value
            resolve(false)
          })
      } else {
        // 如果已经在监听中，直接返回成功
        console.log('已经在监听中');
        status.value = '监听中'
        resolve(true)
      }
    })
  }

  /**
 * 停止语音识别监听
 */
  const stopListening = () => {
    if (recognition && isListening) {
      isListening = false
      recognition.stop()
      status.value = '已停止监听'
      console.log('停止监听');
    }
  }

  /**
   * 停止录音（如果正在进行）
   */
  const stopRecording = () => {
    // 停止录音
    if (mediaRecorder && mediaRecorder.state !== 'inactive') {
      mediaRecorder.stop()
      status.value = '录音已停止'
    }
    // 清除静音计时器
    clearTimeout(silenceTimer)
    // 取消动画帧
    if (animationFrameId) {
      cancelAnimationFrame(animationFrameId)
      animationFrameId = null
    }
    // 关闭音频上下文
    if (audioContext) {
      audioContext.close()
      audioContext = null
    }
  }

  /**
   * 停止所有语音相关功能（监听和录音）
   */
  const stop = () => {
    stopListening()
    stopRecording()
  }

  /**
   * 取消当前的语音识别监听
   */
  const cancelListening = () => {
    if (recognition && isListening) {
      isListening = false
      recognition.stop()
      status.value = '已取消监听'
      console.log('取消监听');
    }
  }

  onUnmounted(() => {
    isListening = false
    isPromptDetected = false
    stop()
  })

  return {
    status,
    talkText,
    init,
    start,
    stop,
    cancelListening,
    permissionStatus,
    conversationHistory,
    isRecording
  }
}
