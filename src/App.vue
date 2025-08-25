<template>
  <div>
    <h2>语音识别</h2>
    <div class="status">
      状态：<span>{{ status }}</span>
    </div>
    <div class="talk-text">
      你说的是：<span>{{ talkText || '---' }}</span>
    </div>
  </div>
</template>

<script setup>
import { nextTick, onMounted, ref } from 'vue'
import { useSTT } from '@/hooks/useSTT'

const { status, talkText, init, start, permissionStatus } = useSTT()

onMounted(() => {
  init()
  nextTick(() => {
    if (permissionStatus.value === 'granted') {
      start()
    }
  })
})
</script>

<style lang="scss" scoped>
.status {
  margin-bottom: 10px;
}

.talk-text {
  margin-bottom: 5px;
}
</style>
