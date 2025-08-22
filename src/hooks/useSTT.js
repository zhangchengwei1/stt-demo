import { ref, onUnmounted } from 'vue'
import annyang from 'annyang'
import { getAudioTranscriptions } from '@/api'

let audioChunks = [] // 临时变量，用于存储录音数据
let mediaRecorder // 媒体记录器实例
const error = ref('')
// 语音识别状态
const status = ref('未初始化')
// 识别到的文本
const talkText = ref('')

// 请求麦克风权限
const requestPermissionAndStart = async () => {
  isRequesting.value = true
  error.value = ''

  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
    permissionStatus.value = 'granted'
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
  } finally {
    isRequesting.value = false
  }
}

// 开始录音
// 当两秒钟没说话时，自动停止录音
const startRecording = (stream) => {
  audioChunks = []
  mediaRecorder = new MediaRecorder(stream)
  mediaRecorder.ondataavailable = (e) => {
    audioChunks.push(e.data)
  }
  mediaRecorder.onstop = () => {
    const audioBlob = new Blob(audioChunks, { type: 'audio/webm' })
    // 停止所有音轨
    stream.getTracks().forEach(track => track.stop())
    // 释放媒体
    mediaRecorder = null
    const audioUrl = URL.createObjectURL(audioBlob)
    console.log('audioUrl', audioUrl)
    // 调用大模型识别语音
    const formData = new FormData()
    formData.append('file', audioBlob)
    formData.append('model', 'FunAudioLLM/SenseVoiceSmall')
    getAudioTranscriptions(formData).then(res => {
      console.log('【大模型识别结果】', res.data);
      talkText.value = res.data?.text || ''
      status.value = '已识别'
      // 识别到文本后，自动停止录音
      stopRecording()
    }).catch(err => {
      console.log('err', err);
      status.value = '识别失败'
    })
  }
  mediaRecorder.start()
}

const stopRecording = () => {
  if (mediaRecorder?.state === 'recording') {
    mediaRecorder.stop()
  }
}

/**
 * 语音识别自定义钩子
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
          // talkText.value = '小瞳小瞳' + voice
          // 调用大模型获取后续的内容，确保信息得当
          requestPermissionAndStart()
        }
      })
      annyang.addCommands({
        '小同小同 :voice': (voice) => {
          // talkText.value = '小瞳小瞳' + voice
          // 调用大模型获取后续的内容 ,确保信息得当
          requestPermissionAndStart()
        }
      })
    } else {
      status.value = '初始化失败'
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
    stopRecording()
  })

  return {
    status,
    talkText,
    init,
    start
  }
}
