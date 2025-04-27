<template>
  <div v-if="uin">
    <el-row :gutter="24">
      <el-col :span="24" class="mb-[18px]">
        <el-card shadow="never">
          <el-container>
            <el-aside width="100px">
              <el-avatar :size="100" :src="QQBotMap[uin].avatar"
            /></el-aside>
            <el-container>
              <el-header height="30px">{{ QQBotMap[uin].nickname }}</el-header>
              <el-main>
                <el-select
                  v-model="uin"
                  placeholder="Select"
                  style="width: 150px"
                  @change="handleSelectChange"
                >
                  <el-option
                    v-for="item in QQBotMap"
                    :key="item.uin"
                    :label="item.uin"
                    :value="item.uin"
                  />
                </el-select>
              </el-main>
            </el-container>
          </el-container>
        </el-card>
      </el-col>

      <el-col
        v-for="(item, index) in chartData"
        :key="index"
        v-motion
        style="margin-bottom: 18px"
        :xl="4"
        :sm="12"
        :xs="12"
      >
        <el-card class="line-card" shadow="never">
          <el-skeleton
            :loading="!item.name"
            animated
            :rows="1"
            style="height: 82px"
          >
            <template #default>
              <div style="display: flex; justify-content: space-between">
                <span class="text-md font-medium" style="font-size: 1rem">
                  {{ item.name }}
                </span>
                <div
                  style="
                    width: 2rem;
                    height: 2rem;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    border-radius: 0.375rem;
                  "
                  :style="{
                    backgroundColor: isDark ? 'transparent' : item.bgColor,
                  }"
                >
                  <span v-if="item.total">总计</span>
                </div>
              </div>
              <div
                style="
                  display: flex;
                  justify-content: space-between;
                  align-items: end;
                  margin-top: 0.75rem;
                "
              >
                <div class="w-1/2">
                  <div
                    class="text-[1.6em]"
                    style="font-size: 1.6rem; width: 50%"
                  >
                    {{ item.value }}
                  </div>
                </div>
                <div>{{ item.total }}</div>
              </div>
            </template>
          </el-skeleton>
        </el-card>
      </el-col>

      <el-col v-motion class="mb-[18px]" :xl="16" :md="24" :xs="24" :sm="24">
        <el-card class="bar-card" shadow="never">
          <el-skeleton :loading="!weekChartData.length" animated>
            <template #default>
              <div class="flex justify-between">
                <span class="text-md font-medium">最近用户量</span>
                <el-segmented
                  v-model="curWeek"
                  :options="[
                    { label: '7天', value: 0 },
                    { label: '30天', value: 1 },
                  ]"
                />
              </div>
              <div class="flex justify-between items-start mt-3">
                <ChartBar
                  :userData="weekChartData[curWeek]?.userData"
                  :groupData="weekChartData[curWeek]?.groupData"
                  :weekData="weekChartData[curWeek]?.weekData"
                  :receiveMsgData="weekChartData[curWeek]?.receiveMsgData"
                  :sendMsgData="weekChartData[curWeek]?.sendMsgData"
                />
              </div>
            </template>
            <template #template>
              <el-skeleton-item
                variant="h1"
                class="mb-[40px]"
                style="width: 10%"
              />
              <el-skeleton-item
                variant="rect"
                class="mb-[30px]"
                style="width: 100%; height: 300px"
              />
            </template>
          </el-skeleton>
        </el-card>
      </el-col>

      <el-col v-motion class="mb-[18px]" :xl="8" :xs="24" :md="24" :sm="24">
        <el-card shadow="never">
          <el-skeleton v-if="!callStat.length" animated>
            <template #template>
              <el-skeleton-item
                class="mb-[40px]"
                variant="h1"
                style="width: 20%"
              />
              <div class="flex justify-center">
                <el-skeleton-item
                  variant="circle"
                  class="mb-[30px] flex mt-2"
                  style="width: 300px; height: 300px"
                />
              </div>
            </template>
          </el-skeleton>
          <div v-show="callStat.length">
            <div class="flex justify-between">
              <span class="text-md font-medium">调用统计</span>
            </div>
            <div class="flex justify-between items-start mt-3">
              <ChartPie :chartData="callStat" />
            </div>
          </div>
        </el-card>
      </el-col>
    </el-row>
  </div>
  <el-card v-else>
    <el-result icon="warning" title="没有找到QQBot数据" />
  </el-card>
</template>

<script setup lang="ts">
import { ref, markRaw } from "vue";
import ChartBar from "ChartBar.vue";
import ChartPie from "ChartPie.vue";
import { useDark } from "@pureadmin/utils";

const props = defineProps({
  request: Function,
});

const chartData = ref<any>(Array.from({ length: 6 }, (_, index) => ({})));

const weekChartData = ref<
  {
    userData: number[];
    groupData: number[];
    weekData: string[];
    receiveMsgData: number[];
    sendMsgData: number[];
  }[]
>([]);
const callStat = ref([]);
const QQBotMap = ref<{
  [uin: string]: { name: string; uin: string; avatar: string };
}>({});
const uin = ref<string>(null);

const getData = () => {
  props
    .request("post", `/get-home-data`, {
      data: {
        uin: uin.value,
      },
    })
    .then((res) => {
      if (res.success) {
        QQBotMap.value = res.data.QQBotMap;
        uin.value = res.data.uin;
        chartData.value = res.data.chartData;
        weekChartData.value = res.data.weekData;
        callStat.value = res.data.callStat;
      }
    });
};

getData();

const handleSelectChange = (value: string) => {
  getData();
};

defineOptions({
  name: "Welcome",
});

const { isDark } = useDark();

let curWeek = ref(0); // 0: 7天、1: 30天
</script>

<style scoped></style>
