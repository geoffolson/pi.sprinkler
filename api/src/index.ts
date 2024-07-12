import express, { Request, Response, NextFunction } from "express";
import { config } from "./loadConfig";
import { PrismaClient } from "@prisma/client";
import { IrrigationPin, IrrigationSchedule, IrrigationZone } from "common";
import { z } from "zod";
import type { IrrigationZoneDuration } from "@prisma/client";
import { Job, scheduleJob } from "node-schedule";
import { Gpio } from "pigpio";

const MINUTE = 1000 * 60; // in milliseconds
const delayMinutes = (minutes: number) =>
  new Promise((resolve) => setTimeout(resolve, minutes * MINUTE));

const prisma = new PrismaClient();

const app = express();
const port = config.port;

// Async wrapper function
const asyncHandler =
  (fn: Function) => (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };

let jobs: { job: Job; id: number }[] = [];

(async () => {
  const schedules = await prisma.schedule.findMany({
    include: {
      channels: { include: { irrigationZone: { include: { channel: true } } } },
    },
  });

  jobs = schedules.map((schedule) => {
    return {
      id: schedule.id,
      job: scheduleJob(schedule.cron, async () => {
        for (const channel of schedule.channels) {
          const duration =
            channel.type === "precipitation"
              ? channel.irrigationZone.precipitationRate *
                channel.durationOrInches *
                60
              : channel.durationOrInches;
          channel.irrigationZone.channel.gpioPin;
          const gpio = new Gpio(channel.irrigationZone.channel.gpioPin, {
            mode: Gpio.OUTPUT,
          });
          gpio.digitalWrite(0);
          await delayMinutes(duration);
          gpio.digitalWrite(1);
        }
      }),
    };
  });
})();

app.use(express.json());

app.post(
  "/irrigation-pin",
  asyncHandler(async (req: Request, res: Response) => {
    const data = IrrigationPin.parse(req.body);
    await prisma.irrigationPin.upsert({
      create: data,
      update: data,
      where: {
        channel: data.channel,
      },
    });
    res.send();
  })
);

app.post(
  "/irrigation-zone",
  asyncHandler(async (req: Request, res: Response) => {
    const data = IrrigationZone.parse(req.body);
    await prisma.irrigationZone.upsert({
      create: {
        name: data.name,
        irrigationPinChannel: data.channel,
        precipitationRate: data.precipitationRate,
      },
      update: {
        name: data.name,
        irrigationPinChannel: data.channel,
        precipitationRate: data.precipitationRate,
      },
      where: {
        irrigationPinChannel: data.channel,
      },
    });
  })
);

const IdQuerySchema = z.object({ id: z.coerce.number() });
app.get(
  "/schedule",
  asyncHandler(async (req: Request, res: Response) => {
    const { id } = IdQuerySchema.parse(req.query);
    const schedule = await prisma.schedule.findFirst({
      where: { id },
      include: { channels: true },
    });
    res.send(schedule);
  })
);
app.get(
  "/schedules",
  asyncHandler(async (req: Request, res: Response) => {
    const schedules = await prisma.schedule.findMany({
      include: { channels: true },
    });
    res.send(schedules);
  })
);
app.post(
  "/schedule",
  asyncHandler(async (req: Request, res: Response) => {
    const data = IrrigationSchedule.parse(req.body);
    const schedule = await prisma.schedule.create({
      data: {
        cron: data.cron,
        channels: {
          createMany: {
            data: data.channels.map(
              (zone): Omit<IrrigationZoneDuration, "id" | "scheduleId"> => {
                return {
                  type: zone.type,
                  durationOrInches: zone.durationOrInches,
                  irrigationZoneIrrigationPinChannel: zone.channel,
                };
              }
            ),
          },
        },
      },
      include: {
        channels: true,
      },
    });
    res.send(schedule);
  })
);

const IdDeleteSchema = z.object({ id: z.number() });
app.delete(
  "/schedule",
  asyncHandler(async (req: Request, res: Response) => {
    const { id } = IdDeleteSchema.parse(req.body);
    await prisma.schedule.delete({
      include: { channels: true },
      where: { id },
    });
    res.send();
  })
);

// Error handling middleware
app.use((err: Error, req: Request, res: Response, next: NextFunction) => {
  console.error(err.stack);
  res.status(500).send({ error: "Something went wrong!" });
});

app.listen(port, () => {
  console.log(`Example app listening at http://localhost:${port}`);
});
