import { createApp } from 'vue'
import { createPinia } from 'pinia'
import FloatingVue from 'floating-vue'
import App from './App.vue'

import 'floating-vue/dist/style.css'
import 'splitpanes/dist/splitpanes.css'
import 'virtual:uno.css'
import './styles/main.scss'

const app = createApp(App)
app.use(createPinia())
app.use(FloatingVue, {
  themes: {
    tooltip: {
      delay: { show: 200, hide: 0 },
      distance: 8,
      overflowPadding: 8,
    },
  },
})
app.mount('#app')
