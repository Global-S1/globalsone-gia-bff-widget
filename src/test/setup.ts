/**
 * Preparación común de las pruebas.
 *
 * La configuración lee `BFF_JWT_SECRET` al importarse y, si no está, **cae a la
 * cadena literal `"change-me"`**. Fijarlo aquí hace las pruebas deterministas y,
 * de paso, evita que una suite pase por usar ese valor por defecto.
 */

process.env.BFF_JWT_SECRET ??= "secreto-de-pruebas-no-usar-fuera";
