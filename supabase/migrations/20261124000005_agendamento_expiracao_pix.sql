-- Cancela pedidos com Pix não pago após 30 minutos (roda a cada minuto)
create extension if not exists pg_cron;
select cron.schedule('expirar-pix-nao-pago', '* * * * *', $$select public.expire_pending_payments(30)$$);
