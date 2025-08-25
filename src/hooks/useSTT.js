import { ref, onUnmounted } from 'vue'
import annyang from 'annyang'
import { getAudioTranscriptions } from '@/api'

let audioChunks = [] // 临时变量，用于存储录音数据
let mediaRecorder // 媒体记录器实例
let audioContext = null // 音频上下文
let silenceTimer = null // 静音计时器
let animationFrameId = null // 动画帧ID，用于音频能量检测
const error = ref('')
// 语音识别状态
const status = ref('未初始化')
// 识别到的文本
const talkText = ref('')
// 请求状态
const isRequesting = ref(false)
// 权限状态
const permissionStatus = ref('init')

// 请求麦克风权限
const requestPermissionAndStart = async () => {
  isRequesting.value = true
  error.value = ''

  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
    permissionStatus.value = 'granted'
    status.value = '获取麦克风权限成功'
    console.log('成功获取麦克风权限')

    // 开始录音示例
    startRecording(stream)
  } catch (err) {
    console.error('获取麦克风权限失败:', err)
    permissionStatus.value = 'denied'
    if (err.name === 'NotAllowedError') {
      error.value = '用户拒绝了麦克风权限'
    } else if (err.name === 'NotFoundError') {
      error.value = '未找到麦克风设备'
    } else {
      error.value = '获取麦克风权限失败: ' + err.message
    }
    status.value = '获取麦克风权限失败::' + error.value
  } finally {
    isRequesting.value = false
  }
}

/**
 * 开始录音
 * 当两秒钟没说话时，自动停止录音
 * @param {MediaStream} stream - 音频流
 */
const startRecording = (stream) => {
  // 重置状态
  audioChunks = []
  clearTimeout(silenceTimer)
  status.value = '录音中'

  // 创建媒体记录器
  mediaRecorder = new MediaRecorder(stream)
  mediaRecorder.ondataavailable = (e) => {
    audioChunks.push(e.data)
  }
  mediaRecorder.onstop = () => {
    const audioBlob = new Blob(audioChunks, { type: 'audio/webm' })
    // 停止所有音轨
    stream.getTracks().forEach(track => track.stop())
    // 释放资源
    mediaRecorder = null
    if (audioContext) {
      audioContext.close()
      audioContext = null
    }
    clearTimeout(silenceTimer)

    const audioUrl = URL.createObjectURL(audioBlob)
    console.log('audioUrl', audioUrl)

    // 调用大模型识别语音
    const formData = new FormData()
    formData.append('file', audioBlob)
    formData.append('model', 'FunAudioLLM/SenseVoiceSmall')
    getAudioTranscriptions(formData).then(res => {
      console.log('【大模型识别结果】', res.data);
      talkText.value = res.data?.text || ''
      status.value = '大模型识别成功'
    }).catch(err => {
      console.log('err', err);
      status.value = '大模型识别失败'
    })
  }

  // 创建音频上下文分析音频能量
  try {
    audioContext = new (window.AudioContext || window.webkitAudioContext)()
    const analyser = audioContext.createAnalyser()
    const microphone = audioContext.createMediaStreamSource(stream)

    // 平滑值
    // analyser.smoothingTimeConstant = 0.8
    analyser.fftSize = 1024

    microphone.connect(analyser)

    // 使用requestAnimationFrame
    const checkAudioEnergy = () => {
      const array = new Uint8Array(analyser.frequencyBinCount)
      analyser.getByteFrequencyData(array)
      let values = 0
      let average = 0

      // 计算音频能量平均值
      for (let i = 0; i < array.length; i++) {
        values += array[i]
      }
      average = values / array.length

      // 如果音频能量大于阈值，认为有声音
      if (average > 10) {
        // 重置静音计时器
        clearTimeout(silenceTimer)
        silenceTimer = setTimeout(() => {
          // 两秒无声音，停止录音
          if (mediaRecorder?.state === 'recording') {
            console.log('两秒无声音，自动停止录音')
            status.value = '两秒无声音，自动停止录音'
            mediaRecorder.stop()
          }
        }, 2000)
      }

      // 继续请求下一帧
      if (mediaRecorder?.state === 'recording') {
        animationFrameId = requestAnimationFrame(checkAudioEnergy)
      }
    }

    // 启动能量检测循环
    animationFrameId = requestAnimationFrame(checkAudioEnergy)
  } catch (err) {
    console.error('创建音频上下文失败:', err)
  }

  mediaRecorder.start()
  // 初始设置静音计时器
  silenceTimer = setTimeout(() => {
    if (mediaRecorder?.state === 'recording') {
      console.log('两秒无声音，自动停止录音')
      status.value = '两秒无声音，自动停止录音'
      mediaRecorder.stop()
    }
  }, 2000)

}

/**
 * 停止录音
 * 清理相关资源，包括媒体记录器、音频上下文和静音计时器
 */
const stopRecording = () => {
  // 停止录音
  if (mediaRecorder && mediaRecorder.state !== 'inactive') {
    mediaRecorder.stop()
    status.value = '录音已停止'
  }
  // 清除静音计时器
  clearTimeout(silenceTimer)
  // 取消
  if (animationFrameId) {
    cancelAnimationFrame(animationFrameId)
    animationFrameId = null
  }
  // 关闭音频上下文
  if (audioContext) {
    audioContext.close()
    audioContext = null
  }
  // 停止annyang
  if (annyang && annyang.isListening()) {
    annyang.abort()
  }
}

/**
 * 语音识别自定义hook
 * 提供语音识别的初始化、启动、停止功能，以及状态和识别文本的响应式变量
 * @returns {Object} 包含状态、识别文本和控制方法的对象
 */
export const useSTT = () => {
  /**
   * 初始化语音识别
   * 设置语言并添加命令
   */
  const init = () => {
    console.log('init', annyang);
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      // 不支持getUserMedia
      status.value = '浏览器不支持 getUserMedia API'
      console.log('浏览器不支持 getUserMedia API');
    }
    if (annyang) {
      status.value = '已初始化'
      annyang.setLanguage('zh-CN')
      annyang.debug()
      // annyang.addCallback('error', (error) => {
      //   console.log('error', error);
      // })
      annyang.addCommands({
        '小瞳小瞳 :voice': (voice) => {
          console.log('测试annyang voice---', voice);
          status.value = 'annyang 识别到提示词'
          // 调用大模型获取后续的内容，确保信息得当
          requestPermissionAndStart()
        }
      })
      // annyang.addCommands({
      //   '小同小同 :voice': (voice) => {
      //     // 调用大模型获取后续的内容 ,确保信息得当
      //     requestPermissionAndStart()
      //   }
      // })
    } else {
      status.value = 'annyang初始化失败'
    }
  }

  /**
   * 启动语音识别
   */
  const start = () => {
    if (annyang) {
      annyang.start({
        continuous: true
      })
    }
  }

  // 在组件卸载时清理资源
  onUnmounted(() => {
    if (annyang) {
      annyang.abort()
      annyang.removeCommands()
    }
    if (silenceTimer) {
      clearTimeout(silenceTimer)
    }
    if (animationFrameId) {
      cancelAnimationFrame(animationFrameId)
      animationFrameId = null
    }
    if (audioContext) {
      audioContext.close()
      audioContext = null
    }
    if (mediaRecorder) {
      mediaRecorder.stop()
      mediaRecorder = null
    }
    stopRecording()
  })

  return {
    status,
    talkText,
    init,
    start,
    permissionStatus
  }
}
