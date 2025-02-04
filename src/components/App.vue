<template>
  <drag-and-drop enabled @drop-files="loadFiles" id="app-container">
    <template v-slot="{ dragHover }">
      <v-app>
        <app-bar v-if="false" @click:left-menu="leftSideBar = !leftSideBar"></app-bar>
        <v-navigation-drawer
          v-model="leftSideBar"
          app
          clipped
          touchless
          width="350"
          id="left-nav"
          location="end"
          mobile-breakpoint="0"
          disable-resize-watcher
          disable-route-watcher
          :temporary="temporaryDrawer"
        >
          <module-panel @close="leftSideBar = false" />
        </v-navigation-drawer>
        <v-main id="content-main">
          <div class="fill-height d-flex flex-row flex-grow-1">
            <controls-strip :has-data="hasData" :left-menu="leftSideBar" @click:left-menu="leftSideBar = !leftSideBar" @click:close="closeApp"></controls-strip>
            <div class="d-flex flex-column flex-grow-1">
              <layout-grid v-show="hasData" :layout="layout" />
              <welcome-page
                v-if="!hasData"
                :loading="showLoading"
                class="clickable"
                @click="loadUserPromptedFiles"
              >
              </welcome-page>
            </div>
          </div>
        </v-main>
        <controls-modal />
      </v-app>
      <persistent-overlay
        :disabled="!dragHover"
        color="#000"
        :opacity="0.3"
        :z-index="2000"
        class="text-center"
      >
        <div class="d-flex flex-column align-center justify-center h-100">
          <div class="dnd-prompt">
            <v-icon size="4.75rem">mdi-download</v-icon>
            <div class="text-h2 font-weight-bold">Drop your files to open</div>
          </div>
        </div>
      </persistent-overlay>
    </template>
  </drag-and-drop>
</template>

<script lang="ts">
import { computed, defineComponent, onMounted, ref, watch } from 'vue';
import { storeToRefs } from 'pinia';
import { UrlParams, useUrlSearchParams, watchOnce } from '@vueuse/core';
import vtkURLExtract from '@kitware/vtk.js/Common/Core/URLExtract';
import { useDisplay } from 'vuetify';
import { useLoadDataStore, type Events as EventHandlers, type LoadEvent } from '@/src/store/load-data';
import { useDatasetStore } from '@/src/store/datasets';
import { useViewStore } from '@/src/store/views';
import useRemoteSaveStateStore from '@/src/store/remote-save-state';
import AppBar from '@/src/components/AppBar.vue';
import ControlsStrip from '@/src/components/ControlsStrip.vue';
import {
  loadFiles,
  loadUserPromptedFiles,
  loadUrls,
} from '@/src/actions/loadUserFiles';
import WelcomePage from '@/src/components/WelcomePage.vue';
import { useDICOMStore } from '@/src/store/datasets-dicom';
import LayoutGrid from '@/src/components/LayoutGrid.vue';
import ModulePanel from '@/src/components/ModulePanel.vue';
import DragAndDrop from '@/src/components/DragAndDrop.vue';
import PersistentOverlay from '@/src/components/PersistentOverlay.vue';
import ControlsModal from '@/src/components/ControlsModal.vue';
import { useImageStore } from '@/src/store/datasets-images';
import { useServerStore } from '@/src/store/server';
import { useGlobalErrorHook } from '@/src/composables/useGlobalErrorHook';
import { useKeyboardShortcuts } from '@/src/composables/useKeyboardShortcuts';
import { useEventBus } from '@/src/composables/useEventBus';

export default defineComponent({
  name: 'App',

  components: {
    ControlsStrip,
    LayoutGrid,
    DragAndDrop,
    ModulePanel,
    PersistentOverlay,
    ControlsModal,
    WelcomePage,
    AppBar,
  },

  setup() {
    const imageStore = useImageStore();
    const dicomStore = useDICOMStore();

    useGlobalErrorHook();
    useKeyboardShortcuts();

    // --- file handling --- //

    const loadDataStore = useLoadDataStore();
    const hasData = computed(
      () =>
        loadDataStore.isLoadingByBus ? false :
        imageStore.idList.length > 0 ||
        Object.keys(dicomStore.volumeInfo).length > 0
    );
    // show loading if actually loading or has any data,
    // since the welcome screen shouldn't be visible when
    // a dataset is opened.
    const showLoading = computed(
      () => loadDataStore.isLoading || loadDataStore.isLoadingByBus || hasData.value
    );

    // --- event handling --- //
    /*
    $bus.emitter.emit('load', {
      urlParams: { urls: ['./.tmp/8e532b9d-737ec192-1a85bc02-edd7971b-1d3f07b3.zip'], names: ['archive.zip'] },
      uid: '8e532b9d-737ec192-1a85bc02-edd7971b-1d3f07b3',
      n: 1,
    });
    */

    const dataStore = useDatasetStore();
    const { emitter } = useEventBus(({
      onload(payload: LoadEvent) {
        const { urlParams, ...options } = payload;

        if (!urlParams || !urlParams.urls) {
          return;
        }

        // make use of volumeKeyUID (if any) as volumeKeySuffix (if it is not specified)
        const volumeKeyUID = options.volumeKeyUID || options.uid;
        if (volumeKeyUID) {
          if (!('volumeKeySuffix' in options)) options.volumeKeySuffix = volumeKeyUID;
          delete options.uid;
        }

        loadUrls(payload.urlParams, options);
      },
      onunload() {
        // remove all data loaded by event bus
        Object.keys(loadDataStore.dataIDToVolumeKeyUID).forEach(dataID => {
          dataStore.remove(dataID);
        });
      },
      onunselect() {
        dataStore.setPrimarySelection(null);
      },
    } as unknown as EventHandlers), loadDataStore);

    const { primarySelection } = storeToRefs(dataStore);
    watch(primarySelection, async (volumeKey) => {
      if (volumeKey) {
        const volumeKeySuffix = loadDataStore.dataIDToVolumeKeyUID[volumeKey] || dicomStore.volumeKeyGetSuffix(volumeKey);
        if (volumeKeySuffix) {
          const vol = loadDataStore.loadedByBus[volumeKeySuffix].volumes[volumeKey];
          if (vol.layoutName) {
            useViewStore().setLayoutByName(vol.layoutName);
          }
        }
      }
    });

    // --- parse URL -- //
    // http://localhost:8043/?names=[archive.zip]&urls=[./.tmp/8e532b9d-737ec192-1a85bc02-edd7971b-1d3f07b3.zip]&uid=8e532b9d-737ec192-1a85bc02-edd7971b-1d3f07b3&s=0
    // http://localhost:8043/?names=[archive.zip]&urls=[./.tmp/ec780211-db457dfe-ca89dfa0-aae410f6-e5938432.zip]&uid=ec780211-db457dfe-ca89dfa0-aae410f6-e5938432&i=0

    const urlParams = vtkURLExtract.extractURLParameters() as UrlParams;
    const query = useUrlSearchParams();

    onMounted(() => {
      if (!urlParams.urls) {
        return;
      }

      const volumeKeyUID = urlParams.volumeKeyUID || urlParams.uid;
      if (volumeKeyUID) {
        const options = JSON.parse(JSON.stringify({
          volumeKeySuffix: volumeKeyUID as string,
          v: urlParams.v,
          s: urlParams.s ?? undefined,
          n: urlParams.n ?? undefined,
          i: urlParams.i ?? undefined,
        }));
        loadUrls(urlParams, options);
        return;
      }

      loadUrls(urlParams);
    });

    // --- remote server --- //

    const serverStore = useServerStore();

    onMounted(() => {
      serverStore.connect();
    });

    // --- save state --- //

    if (import.meta.env.VITE_ENABLE_REMOTE_SAVE && urlParams.save) {
      // Avoid dropping JSON or array query param arguments on the "save" query parameter
      // by parsing query params without casting to native types in vtkURLExtract.
      const queryParams = new URLSearchParams(window.location.search);
      const saveUrl = queryParams.get('save');
      if (saveUrl) {
        useRemoteSaveStateStore().setSaveUrl(saveUrl);
      }
    }

    // --- layout --- //

    const { layout } = storeToRefs(useViewStore());

    // --- //

    const display = useDisplay();

    const permanentDrawer = computed(() => query.drawer === 'permanent');
    const temporaryDrawer = computed(() => permanentDrawer.value ? false : display.xlAndDown.value);
    const leftSideBar = ref(false);

    watchOnce(display.mobile, (isMobile) => {
      if (!isMobile && !leftSideBar.value) {
        leftSideBar.value = !temporaryDrawer.value;
      }
    }, { immediate: !display.mobile.value });

    return {
      emitter,
      closeApp: () => {
        emitter.emit('unselect');
        setTimeout(() => {
          emitter.emit('close');
        }, 100);
      },

      temporaryDrawer,
      leftSideBar,
      loadUserPromptedFiles,
      loadFiles,
      hasData,
      showLoading,
      layout,
    };
  },
});
</script>

<style>
#content-main {
  /* disable v-content transition when we resize our app drawer */
  transition: initial;
  width: 100%;
  height: 100%;
  position: fixed;
}

#left-nav {
  border-right: 1px solid rgb(var(--v-theme-background));
}

#content-main > .v-content__wrap {
  display: flex;
}

#module-switcher .v-input__prepend-inner {
  /* better icon alignment */
  margin-top: 15px;
}

.alert > .v-snack__wrapper {
  /* transition background color */
  transition: background-color 0.25s;
}
</style>

<style src="@/src/components/styles/utils.css"></style>

<style scoped>
#app-container {
  width: 100%;
  height: 100%;
}

.dnd-prompt {
  background: rgba(0, 0, 0, 0.4);
  color: white;
  border-radius: 8px;
  box-shadow: 0px 0px 10px 5px rgba(0, 0, 0, 0.4);
  padding: 64px;
  visibility: hidden;
}
</style>
