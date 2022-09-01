/*
 * © 2021 Thoughtworks, Inc.
 */

import { Athena } from 'aws-sdk'
import {
  BillingDataRow,
  COMPUTE_PROCESSOR_TYPES,
} from '@cloud-carbon-footprint/core'
import {
  configLoader,
  containsAny,
  CCFConfig,
} from '@cloud-carbon-footprint/common'
import {
  BURSTABLE_INSTANCE_BASELINE_UTILIZATION,
  EC2_INSTANCE_TYPES,
  GPU_INSTANCES_TYPES,
  INSTANCE_TYPE_COMPUTE_PROCESSOR_MAPPING,
  INSTANCE_TYPE_GPU_PROCESSOR_MAPPING,
  MSK_INSTANCE_TYPES,
  REDSHIFT_INSTANCE_TYPES,
} from './AWSInstanceTypes'
import { KNOWN_USAGE_UNITS } from './CostAndUsageTypes'
import { AWS_CLOUD_CONSTANTS } from '../domain'
import { concat } from 'ramda'
import { AWS_REPLICATION_FACTORS_FOR_SERVICES } from './ReplicationFactors'

const GLUE_VCPUS_PER_USAGE = 4
const SIMPLE_DB_VCPUS__PER_USAGE = 1

export default class CostAndUsageReportsRow extends BillingDataRow {
  constructor(usageRowsHeader: Athena.Row, rowData: Athena.datumList) {
    const billingDataRowKeys = usageRowsHeader.Data.map((column) =>
      Object.values(column),
    ).flat()
    const billingDataRowValues = rowData
      .map((column) => Object.values(column))
      .flat()
    const billingDataRow = Object.fromEntries(
      billingDataRowKeys.map((_, i) => [
        billingDataRowKeys[i],
        billingDataRowValues[i],
      ]),
    )
    super(billingDataRow)

    this.usageAmount = this.getUsageAmount()
    this.vCpuHours = this.getVCpuHours(Number(this.vCpus))
    this.gpuHours = this.getGpuHours()
    this.usageUnit = this.getUsageUnit()
    this.timestamp = new Date(this.timestamp)
    this.cost = Number(this.cost)
    this.accountId = this.accountName
    this.cloudProvider = 'AWS'
    this.instanceType = this.parseInstanceTypeFromUsageType()
    this.replicationFactor = this.getReplicationFactor(billingDataRow)
    this.tags = {} // TODO: we currently don't support resource tags for AWS

    const config = configLoader()
    const AWS: CCFConfig['AWS'] = config.AWS
    if (!AWS.accounts) AWS.accounts = []
    for (const account of AWS.accounts) {
      if (account.id === this.accountId) {
        this.accountName = account.name
        break
      }
    }
  }

  private getUsageAmount(): number {
    if (this.isRedshiftComputeUsage()) return this.usageAmount / 3600
    return this.usageAmount
  }

  private getUsageUnit(): string {
    if (this.usageType.includes('Fargate-GB-Hours'))
      return KNOWN_USAGE_UNITS.GB_HOURS
    if (this.isRedshiftComputeUsage()) return KNOWN_USAGE_UNITS.HOURS_1
    return this.usageUnit
  }

  private isRedshiftComputeUsage(): boolean {
    return (
      this.serviceName === 'AmazonRedshift' &&
      this.usageUnit === KNOWN_USAGE_UNITS.SECONDS_1
    )
  }

  private getVCpuHours(vCpuFromReport: number): number {
    const instanceType = this.extractInstanceTypeFromUsageType()

    // When the service is AWS Glue, 4 virtual CPUs are provisioned (from AWS Docs).
    if (this.serviceName === 'AWSGlue')
      return GLUE_VCPUS_PER_USAGE * this.usageAmount
    if (this.serviceName === 'AmazonSimpleDB')
      return SIMPLE_DB_VCPUS__PER_USAGE * this.usageAmount
    if (this.usageType.includes('Aurora:ServerlessUsage'))
      return this.usageAmount / 4
    if (containsAny(['Fargate-vCPU-Hours', 'CPUCredits'], this.usageType))
      return this.usageAmount
    if (
      containsAny(
        Object.keys(BURSTABLE_INSTANCE_BASELINE_UTILIZATION),
        this.usageType,
      )
    ) {
      return (
        this.getBurstableInstanceVCPu(instanceType.split('.', 2).join('.')) *
        this.usageAmount
      )
    }
    if (!vCpuFromReport)
      return this.extractVCpuFromInstanceType(instanceType) * this.usageAmount
    return vCpuFromReport * this.usageAmount
  }

  private getGpuHours(): number {
    const instanceType = this.extractInstanceTypeFromUsageType()
    return GPU_INSTANCES_TYPES[instanceType] * this.usageAmount || 0
  }

  private extractInstanceTypeFromUsageType(): string {
    return this.usageType
      .split(':')
      .pop()
      .replace(/^((db|cache|dax|dms|ml|mq|KernelGateway-ml|.+Kafka)\.)/, '')
  }

  private getBurstableInstanceVCPu(instanceType: string) {
    return (
      this.extractVCpuFromInstanceType(instanceType) *
      (BURSTABLE_INSTANCE_BASELINE_UTILIZATION[instanceType] /
        AWS_CLOUD_CONSTANTS.AVG_CPU_UTILIZATION_2020)
    )
  }

  private extractVCpuFromInstanceType(instanceType: string): number {
    const [instanceFamily, instanceSize] = instanceType.split('.')
    if (this.usageType.includes('Kafka'))
      return MSK_INSTANCE_TYPES[`Kafka${this.usageType.split('Kafka').pop()}`]
    if (this.serviceName === 'AmazonRedshift')
      return REDSHIFT_INSTANCE_TYPES[instanceFamily]?.[instanceSize]?.[0] / 3600
    return EC2_INSTANCE_TYPES[instanceFamily]?.[instanceSize]?.[0]
  }

  public parseInstanceTypeFromUsageType(): string {
    // Sometimes the CUR usage type for xlarge instances returns only as 'xl', so append 'arge'
    // to make it consistent with other responce data.
    if (this.usageType.endsWith('xl'))
      this.usageType = this.usageType.concat('arge')

    const prefixes = ['db', 'cache', 'Kafka']
    const includesPrefix = prefixes.find((prefix) =>
      this.usageType.includes(prefix),
    )
    return includesPrefix
      ? this.usageType.split(concat(includesPrefix, '.')).pop()
      : this.usageType.split(':').pop()
  }

  private getReplicationFactor(usageRow: CostAndUsageReportsRow): number {
    return (
      (AWS_REPLICATION_FACTORS_FOR_SERVICES[usageRow.serviceName] &&
        AWS_REPLICATION_FACTORS_FOR_SERVICES[usageRow.serviceName](
          usageRow.usageType,
          usageRow.region,
        )) ||
      AWS_REPLICATION_FACTORS_FOR_SERVICES.DEFAULT()
    )
  }

  public getComputeProcessors(): string[] {
    if (this.serviceName === 'AWSLambda') {
      if (this.usageType.endsWith('-ARM')) {
        return [COMPUTE_PROCESSOR_TYPES.AWS_GRAVITON_2]
      } else {
        return [COMPUTE_PROCESSOR_TYPES.UNKNOWN]
      }
    }

    return (
      INSTANCE_TYPE_COMPUTE_PROCESSOR_MAPPING[this.instanceType] || [
        COMPUTE_PROCESSOR_TYPES.UNKNOWN,
      ]
    )
  }

  public getGPUComputeProcessors(): string[] {
    if (this.serviceName === 'AWSLambda') {
      return [COMPUTE_PROCESSOR_TYPES.UNKNOWN]
    }

    return (
      INSTANCE_TYPE_GPU_PROCESSOR_MAPPING[this.instanceType] || [
        COMPUTE_PROCESSOR_TYPES.UNKNOWN,
      ]
    )
  }
}
