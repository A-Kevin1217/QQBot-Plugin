<template>
  <div>
    <PlusForm
      ref="ruleFormRef"
      v-model="newFormInline"
      class="w-[90%]"
      label-position="right"
      :columns="columns"
      :rules="rules"
      :row-props="{ gutter: 10 }"
      :has-footer="false"
      labelWidth="90px"
    >
    </PlusForm>
  </div>
</template>

<script setup lang="ts">
import {
  type PlusColumn,
  type FieldValues,
  PlusForm,
} from "plus-pro-components";
import { ref } from "vue";

export interface FormProps {
  formInline: {
    uin: string;
    templateId: string;
  };
}

const props = withDefaults(defineProps<FormProps>(), {
  formInline: () => ({ uin: "", templateId: "" }),
});

const newFormInline = ref<FieldValues>(props.formInline);

const ruleFormRef = ref();
function getRef() {
  return ruleFormRef.value.formInstance;
}

defineExpose({ getRef });

const rules = {
  uin: [
    {
      required: true,
      message: "请输入机器人uin",
    },
  ],
  templateId: [
    {
      required: true,
      message: "请输入模板ID",
    },
  ],
};

const columns: PlusColumn[] = [
  {
    label: "uin",
    prop: "uin",
    valueType: "input",
    fieldProps: {
      placeholder: "请输入机器人uin",
    },
  },
  {
    label: "模板ID",
    prop: "templateId",
    valueType: "input",
    fieldProps: {
      placeholder: "请输入在开放平台申请的模板ID",
    },
  },
];
</script> 